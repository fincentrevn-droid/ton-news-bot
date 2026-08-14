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
import { sendReviewMessage, uploadPhotoGetFileId, type ReviewMeta } from "./telegram";
import { fetchSourcePosts } from "./sources";
import { checkSafety, cleanContent } from "./safety";
import { logger } from "./logger";
import { areLikelyDuplicate } from "./business-filter";

export type NotifyFn = (msg: string) => Promise<void>;

const silentNotify: NotifyFn = async (_msg) => { /* no-op */ };

// Do not spend AI calls on the same source after the model has already
// rejected it. The cache lives for one source-freshness window and is reset
// naturally when the service restarts.
const AI_REJECTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_ATTEMPTS_PER_RUN = 5;
const aiRejectedSourceHashes = new Map<string, number>();

/**
 * Preserve relevance ranking while giving each source one opportunity before
 * a second post from the same channel. This prevents one prolific channel
 * from consuming the whole generation cycle.
 */
export function prioritizeSourceDiversity<T extends { channel: string }>(posts: T[]): T[] {
  const firstByChannel = new Map<string, T>();
  const remaining: T[] = [];

  for (const post of posts) {
    if (firstByChannel.has(post.channel)) {
      remaining.push(post);
    } else {
      firstByChannel.set(post.channel, post);
    }
  }

  return [...firstByChannel.values(), ...remaining];
}

function wasRecentlyRejectedByAi(hash: string): boolean {
  const rejectedAt = aiRejectedSourceHashes.get(hash);
  if (!rejectedAt) return false;
  if (Date.now() - rejectedAt < AI_REJECTION_TTL_MS) return true;
  aiRejectedSourceHashes.delete(hash);
  return false;
}

/** Quality gate for auto-publish routing (webhook + scheduler share this). */
export function qualifiesForAutoPublish(opts: {
  confidence: string;
  safety: { status: string };
  content: string;
}): boolean {
  if (opts.confidence === "low") return false;
  // Full auto mode is strict: even a stripped suspicious link blocks publication.
  if (opts.safety.status !== "ok") return false;
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
      ? "⚠️ TELEGRAM_STRING_SESSION не задано, Telegram-канали недоступні."
      : `⚠️ Немає свіжих джерел за ${maxSourceAgeHours} год, пост не створено.`;
    await notify(msg);
    return null;
  }

  // Avoid re-using source posts from the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentSources = await db
    .select({ hash: postsTable.sourceTextHash, preview: postsTable.sourcePreview })
    .from(postsTable)
    .where(and(gte(postsTable.createdAt, sevenDaysAgo), eq(postsTable.generatedFromSource, true)));

  const usedHashes = new Set(recentSources.map((r) => r.hash).filter(Boolean));
  const recentPreviews = recentSources
    .map((r) => r.preview)
    .filter((preview): preview is string => Boolean(preview));

  const candidates = prioritizeSourceDiversity(
    sourcePosts.filter(
      (p) =>
        !usedHashes.has(p.textHash) &&
        !wasRecentlyRejectedByAi(p.textHash) &&
        !recentPreviews.some((preview) => areLikelyDuplicate(p.fullText, preview)),
    ),
  );
  if (candidates.length === 0) {
    await notify("ℹ️ Усі свіжі матеріали вже використані або повторюють опубліковані новини.");
    return null;
  }

  let content: string | null = null;
  let postType: "micro" | "short" | "medium" | "long" = "short";
  let confidence = "medium";
  let candidate = candidates[0];
  const skippedHashes = new Set<string>();

  for (let attempt = 0; attempt < Math.min(candidates.length, MAX_SOURCE_ATTEMPTS_PER_RUN); attempt++) {
    const pick = candidates.find((p) => !skippedHashes.has(p.textHash)) ?? candidates[0];
    candidate = pick;

    logger.info(
      { attempt, channel: candidate.channel, score: candidate.relevanceScore, hash: candidate.textHash },
      "Trying source post for generation",
    );

    if (attempt === 0) {
      const mediaNote = candidate.mediaType === "photo" ? " 📷" : "";
      await notify(`📰 Джерело: <b>${candidate.channel}</b>${mediaNote}\n\n🤖 Готую пост...`);
    }

    try {
      ({ content, postType, confidence } = await generatePostContent({
        sourceText: candidate.fullText,
        sourceUrl: candidate.link,
        sourceChannel: candidate.channel,
        sourcePublishedAt: candidate.pubDate,
      }));
      break;
    } catch (err) {
      if (err instanceof Error && err.message === "NO_POST") {
        logger.info({ channel: candidate.channel }, "Source returned NO_POST — trying next");
        skippedHashes.add(candidate.textHash);
        aiRejectedSourceHashes.set(candidate.textHash, Date.now());
        continue;
      }
      throw err;
    }
  }

  if (!content) {
    await notify("ℹ️ Усі джерела визнано непридатними, пост не створено.");
    return null;
  }

  const safety = checkSafety(content);
  const cleanedContent = cleanContent(content, safety);
  await incrementAiUsage("post");

  const hasMedia = candidate.mediaType === "photo" && Boolean(candidate.mediaBuffer);
  const sourceType = candidate.channelUrl?.startsWith("@") ? "telegram_channel" : "rss";

  // ── AI quality check ──────────────────────────────────────────────────────
  const qualityCheckEnabled = process.env.ENABLE_AI_QUALITY_CHECK !== "false";
  const minQualityScore = parseInt(process.env.QUALITY_CHECK_MIN_SCORE ?? "90", 10);
  const maxQualityRewrites = parseInt(process.env.MAX_AUTO_QUALITY_REWRITES ?? "1", 10);

  let finalContent = cleanedContent;
  let qualityResult: QualityCheckResult | null = null;
  let rewriteAttempts = 0;

  if (qualityCheckEnabled) {
    try {
      qualityResult = await runQualityCheck(cleanedContent, candidate.fullText, candidate.pubDate);
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
            sourcePublishedAt: candidate.pubDate,
            originalFormat: postType,
          });
          rewriteAttempts++;

          const recheck = await runQualityCheck(rewritten, candidate.fullText, candidate.pubDate);
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
      logger.warn({ qcErr }, "Quality check failed — strict gate will reject the post");
    }
  }

  // ── Decide: auto-publish queue or manual review ───────────────────────────
  const schedRows = await db.select().from(schedulesTable).limit(1);
  const schedule = schedRows[0];

  const autoPublishEnabled = schedule?.autoPublish ?? false;
  const qualifies = qualifiesForAutoPublish({ confidence, safety, content: finalContent });
  const qualityOk = !qualityCheckEnabled
    ? true
    : Boolean(
      qualityResult &&
      qualityResult.passed &&
      qualityResult.quality_score >= minQualityScore &&
      qualityResult.safe_for_autopublish,
    );
  // Source must be fresh (within MAX_SOURCE_AGE_HOURS) and generated from a real source
  const sourceAgeOk = candidate.pubDate >= freshnessThreshold;
  const routeToQueue = autoPublishEnabled && qualifies && qualityOk && sourceAgeOk;
  const skipForFullAuto = autoPublishEnabled && !routeToQueue;

  // ── Pre-upload media for queued posts ────────────────────────────────────
  // For manual-review posts, sendReviewMessage uploads the photo and returns file_id.
  // For queued posts, that never happens — upload now so the scheduler can publish with photo.
  let preUploadedFileId: string | null = null;
  if (routeToQueue && hasMedia && candidate.mediaBuffer) {
    try {
      preUploadedFileId = await uploadPhotoGetFileId(candidate.mediaBuffer);
    } catch (err) {
      logger.warn({ err }, "Failed to pre-upload media for queued post — will publish as text");
    }
  }

  // ── Insert post ───────────────────────────────────────────────────────────
  const [post] = await db
    .insert(postsTable)
    .values({
      content: finalContent,
      status: skipForFullAuto ? "skipped" : "draft",
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
      mediaFileId: preUploadedFileId,
      qualityScore: qualityResult?.quality_score ?? null,
      qualityCheckPassed: qualityResult?.passed ?? null,
      qualityIssues: qualityResult?.issues?.length ? JSON.stringify(qualityResult.issues) : null,
      safeForAutopublish: qualityResult?.safe_for_autopublish ?? null,
      rewriteAttempts,
    })
    .returning();

  const photoNote = hasMedia ? " с фото 📷" : "";
  const qcNote = qualityResult ? ` · QC ${qualityResult.quality_score}/100` : "";

  if (skipForFullAuto) {
    logger.info(
      {
        postId: post.id,
        confidence,
        safety: safety.status,
        qualityScore: qualityResult?.quality_score,
        qualityOk,
        sourceAgeOk,
      },
      "Post rejected by strict full-auto filters",
    );
    await notify(
      `⏭️ Матеріал із «<b>${candidate.channel}</b>» не пройшов жорсткі фільтри${qcNote} і пропущений.`,
    );
    return null;
  }

  if (routeToQueue) {
    logger.info(
      { postId: post.id, confidence, safety: safety.status, qualityScore: qualityResult?.quality_score },
      "Post queued for auto-publish",
    );
    await notify(
      `⏳ Пост #${post.id} із «<b>${candidate.channel}</b>»${photoNote} додано до черги автопублікації.${qcNote}`,
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

  await notify(`✅ Пост #${post.id} із «<b>${candidate.channel}</b>»${photoNote}${qcNote} надіслано на перевірку.`);
  return { postId: post.id, queued: false, qualityScore: qualityResult?.quality_score, channel: candidate.channel };
}
