/**
 * auto-generate.ts
 * Core post-generation pipeline, usable from both the webhook handler
 * (manual /generate_now command) and the scheduler (automatic generation).
 */
import { eq, and, gte } from "drizzle-orm";
import { db, postsTable, schedulesTable } from "@workspace/db";
import {
  generatePostContent,
  incrementAiUsage,
  runQualityCheck,
  rewriteWithFeedback,
  type QualityCheckResult,
} from "./openai";
import { sendReviewMessage, type ReviewMeta } from "./telegram";
import { fetchSourcePosts } from "./sources";
import { checkSafety, cleanContent } from "./safety";
import { logger } from "./logger";

export type NotifyFn = (msg: string) => Promise<void>;

const silentNotify: NotifyFn = async (_msg) => { /* no-op */ };

/** Quality gate for auto-publish routing (webhook + scheduler share this). */
export function qualifiesForAutoPublish(opts: {
  confidence: string;
  safety: { status: string };
  content: string;
}): boolean {
  if (opts.confidence === "low") return false;
  // "flagged" = suspicious links stripped (still publishable), "rejected" = blocked
  if (opts.safety.status === "rejected") return false;
  if (!opts.content.trim()) return false;
  if (!opts.content.includes("\n\n")) return false;
  return true;
}

export interface GenerateResult {
  postId: number;
  queued: boolean;        // true = auto-publish queue, false = manual review
  qualityScore?: number;
  channel: string;
}

/**
 * Fetch sources → generate → quality-check → insert → route to queue or review.
 *
 * @param notify  Callback for status messages (Telegram reply or notifyOwner).
 *                Pass nothing / silentNotify for background/scheduler runs.
 */
export async function generateAndQueuePost(
  notify: NotifyFn = silentNotify,
): Promise<GenerateResult | null> {
  const maxSourceAgeHours = parseInt(process.env.MAX_SOURCE_AGE_HOURS ?? "48", 10);
  const freshnessMs = maxSourceAgeHours * 60 * 60 * 1000;
  const freshnessThreshold = new Date(Date.now() - freshnessMs);

  const allSourcePosts = await fetchSourcePosts();

  // ── Freshness filter: discard sources older than MAX_SOURCE_AGE_HOURS ────
  const sourcePosts = allSourcePosts.filter((p) => p.pubDate >= freshnessThreshold);

  if (sourcePosts.length === 0) {
    const noSession = !process.env.TELEGRAM_STRING_SESSION;
    const msg = noSession
      ? "⚠️ TELEGRAM_STRING_SESSION не задан — Telegram-каналы недоступны."
      : `⚠️ Нет свежих источников за ${maxSourceAgeHours}ч — пост не создан.`;
    await notify(msg);
    return null;
  }

  // Avoid re-using source posts from the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentHashes = await db
    .select({ hash: postsTable.sourceTextHash })
    .from(postsTable)
    .where(and(gte(postsTable.createdAt, sevenDaysAgo), eq(postsTable.generatedFromSource, true)));

  const usedHashes = new Set(recentHashes.map((r) => r.hash).filter(Boolean));

  const candidates = sourcePosts.filter((p) => !usedHashes.has(p.textHash));
  if (candidates.length === 0) candidates.push(...sourcePosts); // fallback: reuse

  let content: string | null = null;
  let postType: "micro" | "short" | "medium" | "long" = "short";
  let confidence = "medium";
  let candidate = candidates[0];
  const skippedHashes = new Set<string>();

  for (let attempt = 0; attempt < Math.min(candidates.length, 5); attempt++) {
    const pick = candidates.find((p) => !skippedHashes.has(p.textHash)) ?? candidates[0];
    candidate = pick;

    logger.info(
      { attempt, channel: candidate.channel, score: candidate.relevanceScore, hash: candidate.textHash },
      "Trying source post for generation",
    );

    if (attempt === 0) {
      const mediaNote = candidate.mediaType === "photo" ? " 📷" : "";
      await notify(`📰 Источник: <b>${candidate.channel}</b>${mediaNote}\n\n🤖 Генерирую пост...`);
    }

    try {
      ({ content, postType, confidence } = await generatePostContent({
        sourceText: candidate.fullText,
        sourceUrl: candidate.link,
        sourceChannel: candidate.channel,
      }));
      break;
    } catch (err) {
      if (err instanceof Error && err.message === "NO_POST") {
        logger.info({ channel: candidate.channel }, "Source returned NO_POST — trying next");
        skippedHashes.add(candidate.textHash);
        continue;
      }
      throw err;
    }
  }

  if (!content) {
    await notify("ℹ️ Все источники признаны неподходящими — пост не создан.");
    return null;
  }

  const safety = checkSafety(content);
  const cleanedContent = cleanContent(content, safety);
  await incrementAiUsage("post");

  const hasMedia = candidate.mediaType === "photo" && Boolean(candidate.mediaBuffer);
  const sourceType = candidate.channelUrl?.startsWith("@") ? "telegram_channel" : "rss";

  // ── AI quality check ──────────────────────────────────────────────────────
  const qualityCheckEnabled = process.env.ENABLE_AI_QUALITY_CHECK !== "false";
  const minQualityScore = parseInt(process.env.QUALITY_CHECK_MIN_SCORE ?? "85", 10);
  const maxQualityRewrites = parseInt(process.env.MAX_AUTO_QUALITY_REWRITES ?? "1", 10);

  let finalContent = cleanedContent;
  let qualityResult: QualityCheckResult | null = null;
  let rewriteAttempts = 0;

  if (qualityCheckEnabled) {
    try {
      qualityResult = await runQualityCheck(cleanedContent, candidate.fullText);
      logger.info(
        { score: qualityResult.quality_score, passed: qualityResult.passed, needs_rewrite: qualityResult.needs_rewrite },
        "Quality check result",
      );

      if (
        !qualityResult.passed &&
        qualityResult.needs_rewrite &&
        qualityResult.quality_score >= 60 &&
        rewriteAttempts < maxQualityRewrites
      ) {
        try {
          const rewritten = await rewriteWithFeedback({
            content: cleanedContent,
            issues: qualityResult.issues,
            instruction: qualityResult.rewrite_instruction,
            sourceText: candidate.fullText,
            sourceChannel: candidate.channel,
            originalFormat: postType,
          });
          rewriteAttempts++;

          const recheck = await runQualityCheck(rewritten, candidate.fullText);
          logger.info(
            { score: recheck.quality_score, passed: recheck.passed, rewriteAttempts },
            "Quality re-check after rewrite",
          );

          if (recheck.quality_score >= qualityResult.quality_score) {
            finalContent = rewritten;
            qualityResult = recheck;
          } else {
            qualityResult = recheck;
          }
        } catch (rewriteErr) {
          logger.warn({ rewriteErr }, "Quality rewrite failed — keeping original");
        }
      }
    } catch (qcErr) {
      logger.warn({ qcErr }, "Quality check failed — proceeding without gate");
    }
  }

  // ── Decide: auto-publish queue or manual review ───────────────────────────
  const schedRows = await db.select().from(schedulesTable).limit(1);
  const schedule = schedRows[0];

  const autoPublishEnabled = schedule?.autoPublish ?? false;
  const qualifies = qualifiesForAutoPublish({ confidence, safety, content: finalContent });
  const qualityOk =
    !qualityCheckEnabled ||
    !qualityResult ||
    (qualityResult.quality_score >= minQualityScore && qualityResult.safe_for_autopublish);
  // Source must be fresh (within MAX_SOURCE_AGE_HOURS) and generated from a real source
  const sourceAgeOk = candidate.pubDate >= freshnessThreshold;
  const routeToQueue = autoPublishEnabled && qualifies && qualityOk && sourceAgeOk;

  // ── Insert post ───────────────────────────────────────────────────────────
  const [post] = await db
    .insert(postsTable)
    .values({
      content: finalContent,
      postType,
      safetyStatus: safety.status,
      aiCallsUsed: 1 + rewriteAttempts,
      sourceType,
      sourceUrl: candidate.link || null,
      sourceChannel: candidate.channel,
      sourcePostId: candidate.textHash,
      sourceTextHash: candidate.textHash,
      sourceDate: candidate.pubDate,
      sourceLink: candidate.link || null,
      generatedFromSource: true,
      sourcePreview: candidate.preview,
      confidence,
      hasMedia,
      mediaType: candidate.mediaType ?? null,
      mediaDownloadStatus: hasMedia ? "ok" : null,
      qualityScore: qualityResult?.quality_score ?? null,
      qualityCheckPassed: qualityResult?.passed ?? null,
      qualityIssues: qualityResult?.issues?.length ? JSON.stringify(qualityResult.issues) : null,
      safeForAutopublish: qualityResult?.safe_for_autopublish ?? null,
      rewriteAttempts,
    })
    .returning();

  const photoNote = hasMedia ? " с фото 📷" : "";
  const qcNote = qualityResult ? ` · QC ${qualityResult.quality_score}/100` : "";

  if (routeToQueue) {
    logger.info(
      { postId: post.id, confidence, safety: safety.status, qualityScore: qualityResult?.quality_score },
      "Post queued for auto-publish",
    );
    await notify(
      `⏳ Пост #${post.id} из "<b>${candidate.channel}</b>"${photoNote} добавлен в очередь авто-публикации.${qcNote}`,
    );
    return { postId: post.id, queued: true, qualityScore: qualityResult?.quality_score, channel: candidate.channel };
  }

  // Manual review: send message with ✅ / 🔁 / ❌ buttons
  const reviewMeta: ReviewMeta = {
    sourceChannel: candidate.channel,
    sourcePreview: candidate.preview,
    sourceLink: candidate.link || undefined,
    confidence,
    qualityScore: qualityResult?.quality_score,
    qualityIssues: qualityResult?.issues?.length ? qualityResult.issues : undefined,
    safeForAutopublish: qualityResult?.safe_for_autopublish,
  };

  const { messageId: reviewMsgId, fileId } = await sendReviewMessage(
    post.id,
    finalContent,
    safety.warnings,
    postType,
    undefined,
    reviewMeta,
    hasMedia ? candidate.mediaBuffer : undefined,
  );

  const updateFields: Record<string, unknown> = {};
  if (reviewMsgId) updateFields.reviewMessageId = reviewMsgId;
  if (fileId) updateFields.mediaFileId = fileId;
  if (Object.keys(updateFields).length > 0) {
    await db.update(postsTable).set(updateFields).where(eq(postsTable.id, post.id));
  }

  await notify(`✅ Пост #${post.id} из "<b>${candidate.channel}</b>"${photoNote}${qcNote} отправлен на ревью.`);
  return { postId: post.id, queued: false, qualityScore: qualityResult?.quality_score, channel: candidate.channel };
}
