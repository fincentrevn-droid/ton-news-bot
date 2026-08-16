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
import { getContentProfile } from "../config/content-profile";
import { assessBusinessImageSafety } from "./media-safety";

export type NotifyFn = (msg: string) => Promise<void>;

const silentNotify: NotifyFn = async (_msg) => { /* no-op */ };

// Do not spend AI calls on the same source after the model has already
// rejected it. The cache lives for one source-freshness window and is reset
// naturally when the service restarts.
const AI_REJECTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_ATTEMPTS_PER_RUN = 5;
const aiRejectedSourceHashes = new Map<string, number>();
const contentProfile = getContentProfile();

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

  // Avoid re-using published source posts from the last 7 days. For the
  // business profile, skipped posts are blocked by exact hash for only 24 hours:
  // they must not poison approximate deduplication for an entire week.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let recentSources: Array<{ hash: string | null; preview: string | null }>;
  let recentlySkippedHashes = new Set<string>();

  if (contentProfile.id === "business") {
    const [publishedSources, skippedSources] = await Promise.all([
      db
        .select({ hash: postsTable.sourceTextHash, preview: postsTable.sourcePreview })
        .from(postsTable)
        .where(
          and(
            gte(postsTable.createdAt, sevenDaysAgo),
            eq(postsTable.generatedFromSource, true),
            eq(postsTable.status, "published"),
          ),
        ),
      db
        .select({ hash: postsTable.sourceTextHash })
        .from(postsTable)
        .where(
          and(
            gte(postsTable.createdAt, oneDayAgo),
            eq(postsTable.generatedFromSource, true),
            eq(postsTable.status, "skipped"),
          ),
        ),
    ]);
    recentSources = publishedSources;
    recentlySkippedHashes = new Set(
      skippedSources.map((row) => row.hash).filter((hash): hash is string => Boolean(hash)),
    );
  } else {
    // Preserve the existing PANKOFF CRYPTO behaviour exactly.
    recentSources = await db
      .select({ hash: postsTable.sourceTextHash, preview: postsTable.sourcePreview })
      .from(postsTable)
      .where(
        and(
          gte(postsTable.createdAt, sevenDaysAgo),
          eq(postsTable.generatedFromSource, true),
        ),
      );
  }

  const usedHashes = new Set(
    recentSources
      .map((row) => row.hash)
      .filter((hash): hash is string => Boolean(hash)),
  );
  for (const hash of recentlySkippedHashes) usedHashes.add(hash);

  // Approximate text comparison is intentionally limited to published posts in
  // the business profile. A rejected draft must not suppress a different story.
  const recentPreviews = recentSources
    .map((row) => row.preview)
    .filter((preview): preview is string => Boolean(preview));

  let usedHashRejected = 0;
  let aiRejected = 0;
  let duplicateRejected = 0;
  const filteredSourcePosts = sourcePosts.filter((post) => {
    if (usedHashes.has(post.textHash)) {
      usedHashRejected++;
      return false;
    }
    if (wasRecentlyRejectedByAi(post.textHash)) {
      aiRejected++;
      return false;
    }
    if (recentPreviews.some((preview) => areLikelyDuplicate(post.fullText, preview))) {
      duplicateRejected++;
      return false;
    }
    return true;
  });

  const candidates = prioritizeSourceDiversity(filteredSourcePosts);
  logger.info(
    {
      profile: contentProfile.id,
      fetched: allSourcePosts.length,
      fresh: sourcePosts.length,
      publishedCompared: recentSources.length,
      recentlySkipped: recentlySkippedHashes.size,
      usedHashRejected,
      aiRejected,
      duplicateRejected,
      candidates: candidates.length,
    },
    "Source candidate filter results",
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

  // Download and scan only the selected FINCENTRE image. Business images fail
  // closed: any download/scanner problem produces a normal text-only post.
  let approvedMediaBuffer: Buffer | undefined;
  let mediaDownloadStatus: string | null = null;

  if (!skipForFullAuto && candidate.mediaType === "photo") {
    if (contentProfile.id === "business") {
      let downloadedBuffer = candidate.mediaBuffer;
      try {
        downloadedBuffer ??= await candidate.mediaLoader?.();
      } catch (err) {
        logger.warn({ err, channel: candidate.channel }, "Business photo download failed");
      }

      if (!downloadedBuffer) {
        mediaDownloadStatus = "download_failed";
        logger.info(
          { profile: contentProfile.id, channel: candidate.channel, decision: "text_only", reason: "download_failed" },
          "Business image safety decision",
        );
      } else {
        try {
          const decision = await assessBusinessImageSafety({
            buffer: downloadedBuffer,
            sourceChannel: candidate.channel,
            sourceText: candidate.fullText,
          });
          mediaDownloadStatus = decision.allowed ? "ok" : `rejected:${decision.reason}`;
          if (decision.allowed) approvedMediaBuffer = downloadedBuffer;
          logger.info(
            {
              profile: contentProfile.id,
              channel: candidate.channel,
              decision: decision.allowed ? "photo" : "text_only",
              reason: decision.reason,
              format: decision.format,
              width: decision.width,
              height: decision.height,
              detectedWords: decision.detectedWords,
            },
            "Business image safety decision",
          );
        } catch (err) {
          mediaDownloadStatus = "rejected:scan_failed";
          logger.warn(
            { err, profile: contentProfile.id, channel: candidate.channel },
            "Business image safety scan failed — using text only",
          );
        }
      }
    } else if (candidate.mediaBuffer) {
      // Preserve the existing PANKOFF CRYPTO media path.
      approvedMediaBuffer = candidate.mediaBuffer;
      mediaDownloadStatus = "ok";
    }
  }

  let hasMedia = Boolean(approvedMediaBuffer);

  // ── Pre-upload media for queued posts ────────────────────────────────────
  // For manual-review posts, sendReviewMessage uploads the photo and returns file_id.
  // For queued posts, that never happens — upload now so the scheduler can publish with photo.
  let preUploadedFileId: string | null = null;
  if (routeToQueue && hasMedia && approvedMediaBuffer) {
    try {
      preUploadedFileId = await uploadPhotoGetFileId(approvedMediaBuffer);
    } catch (err) {
      hasMedia = false;
      approvedMediaBuffer = undefined;
      mediaDownloadStatus = "preupload_failed";
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
      mediaDownloadStatus,
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
    hasMedia ? approvedMediaBuffer : undefined,
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
