import { Router } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { db, postsTable } from "@workspace/db";
import {
  ListPostsQueryParams,
  CreatePostBody,
  GetPostParams,
  UpdatePostParams,
  UpdatePostBody,
  DeletePostParams,
  PublishPostParams,
  RegeneratePostParams,
  GeneratePostBody,
} from "@workspace/api-zod";
import { generatePostContent, incrementAiUsage, checkAiLimitReached, getSettings } from "../lib/openai";
import { sendTelegramMessage, sendReviewMessage, notifyOwner } from "../lib/telegram";
import { checkSafety, cleanContent } from "../lib/safety";
import { logger } from "../lib/logger";

const router = Router();

router.get("/posts", async (req, res): Promise<void> => {
  const parsed = ListPostsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { status, limit = 50, offset = 0 } = parsed.data;
  const conditions = status ? [eq(postsTable.status, status)] : [];
  const rows = await db
    .select()
    .from(postsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(postsTable.createdAt))
    .limit(limit)
    .offset(offset);
  res.json(rows);
});

router.post("/posts", async (req, res): Promise<void> => {
  const parsed = CreatePostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [post] = await db
    .insert(postsTable)
    .values({
      content: parsed.data.content,
      postType: (parsed.data.postType as string) ?? "short",
      topic: parsed.data.topic ?? null,
      sourceUrl: parsed.data.sourceUrl ?? null,
      sourceType: (parsed.data.sourceType as string) ?? "manual",
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
    })
    .returning();
  res.status(201).json(post);
});

router.get("/posts/generate", async (_req, res): Promise<void> => {
  res.status(405).json({ error: "Use POST /posts/generate" });
});

router.post("/posts/generate", async (req, res): Promise<void> => {
  const parsed = GeneratePostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const limitCheck = await checkAiLimitReached();
  if (limitCheck.blocked) {
    await notifyOwner(`⚠️ Daily AI limit reached. Generation stopped to avoid extra costs.`);
    res.status(429).json({ error: limitCheck.reason });
    return;
  }

  try {
    const { content, postType } = await generatePostContent({
      topic: parsed.data.topic ?? undefined,
      sourceUrl: parsed.data.sourceUrl ?? undefined,
      forceFormat: parsed.data.forceFormat as "micro" | "short" | "medium" | "long" | undefined,
    });

    const safety = checkSafety(content);

    if (safety.isScam) {
      req.log.warn({ warnings: safety.warnings }, "Scam detected in generated content");
      await notifyOwner(
        `⚠️ Possible scam/fake news detected in generated post. Post was not created.\n\nTopic: ${parsed.data.topic ?? "unknown"}`
      );
      res.status(422).json({ error: "Safety check rejected the generated content as potential scam." });
      return;
    }

    const cleanedContent = cleanContent(content, safety);

    await incrementAiUsage("post");

    const [post] = await db
      .insert(postsTable)
      .values({
        content: cleanedContent,
        postType,
        topic: parsed.data.topic ?? null,
        sourceUrl: parsed.data.sourceUrl ?? null,
        sourceType: (parsed.data.sourceType as string) ?? "manual",
        aiCallsUsed: 1,
        safetyStatus: safety.status,
      })
      .returning();

    const settings = await getSettings();

    if (settings.postingRequiresApproval && !settings.autoPublish) {
      const reviewMsgId = await sendReviewMessage(
        post.id,
        cleanedContent,
        safety.warnings,
        postType,
        parsed.data.topic ?? undefined,
      );
      if (reviewMsgId) {
        const [updated] = await db
          .update(postsTable)
          .set({ reviewMessageId: reviewMsgId })
          .where(eq(postsTable.id, post.id))
          .returning();
        res.status(201).json(updated);
        return;
      }
    }

    if (settings.autoPublish) {
      try {
        const messageId = await sendTelegramMessage(cleanedContent);
        const [published] = await db
          .update(postsTable)
          .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })
          .where(eq(postsTable.id, post.id))
          .returning();
        res.status(201).json(published);
        return;
      } catch (err: unknown) {
        req.log.error({ err }, "Auto-publish failed, returning draft");
      }
    }

    res.status(201).json(post);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "AI generation failed";
    req.log.error({ err }, "Post generation error");
    res.status(500).json({ error: message });
  }
});

router.get("/posts/:id", async (req, res): Promise<void> => {
  const params = GetPostParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [post] = await db.select().from(postsTable).where(eq(postsTable.id, params.data.id));
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  res.json(post);
});

router.patch("/posts/:id", async (req, res): Promise<void> => {
  const params = UpdatePostParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdatePostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = {};
  if (parsed.data.content !== undefined) updateData.content = parsed.data.content;
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.postType !== undefined) updateData.postType = parsed.data.postType;
  if (Object.prototype.hasOwnProperty.call(parsed.data, "scheduledAt")) {
    updateData.scheduledAt = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null;
  }

  const [post] = await db
    .update(postsTable)
    .set(updateData)
    .where(eq(postsTable.id, params.data.id))
    .returning();
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  res.json(post);
});

router.delete("/posts/:id", async (req, res): Promise<void> => {
  const params = DeletePostParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(postsTable).where(eq(postsTable.id, params.data.id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/posts/:id/publish", async (req, res): Promise<void> => {
  const params = PublishPostParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [post] = await db.select().from(postsTable).where(eq(postsTable.id, params.data.id));
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  if (post.status === "published") {
    res.status(400).json({ error: "Post already published" });
    return;
  }

  try {
    const messageId = await sendTelegramMessage(post.content);
    const [updated] = await db
      .update(postsTable)
      .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })
      .where(eq(postsTable.id, params.data.id))
      .returning();
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Telegram publish failed";
    req.log.error({ err }, "Publish failed");
    res.status(500).json({ error: message });
  }
});

router.post("/posts/:id/regenerate", async (req, res): Promise<void> => {
  const params = RegeneratePostParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [post] = await db.select().from(postsTable).where(eq(postsTable.id, params.data.id));
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const limitCheck = await checkAiLimitReached();
  if (limitCheck.blocked) {
    res.status(429).json({ error: limitCheck.reason });
    return;
  }

  try {
    const { content, postType } = await generatePostContent({
      topic: post.topic ?? undefined,
      sourceUrl: post.sourceUrl ?? undefined,
      forceFormat: post.postType as "micro" | "short" | "medium" | "long",
    });

    const safety = checkSafety(content);
    const cleanedContent = cleanContent(content, safety);

    await incrementAiUsage("rewrite");

    const [updated] = await db
      .update(postsTable)
      .set({
        content: cleanedContent,
        postType,
        status: "draft",
        safetyStatus: safety.status,
        aiCallsUsed: (post.aiCallsUsed ?? 0) + 1,
      })
      .where(eq(postsTable.id, params.data.id))
      .returning();

    const settings = await getSettings();
    if (settings.postingRequiresApproval && !settings.autoPublish) {
      const reviewMsgId = await sendReviewMessage(
        updated.id,
        cleanedContent,
        safety.warnings,
        postType,
        post.topic ?? undefined,
      );
      if (reviewMsgId) {
        const [withReview] = await db
          .update(postsTable)
          .set({ reviewMessageId: reviewMsgId })
          .where(eq(postsTable.id, updated.id))
          .returning();
        res.json(withReview);
        return;
      }
    }

    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Regeneration failed";
    req.log.error({ err }, "Regenerate error");
    res.status(500).json({ error: message });
  }
});

export default router;
