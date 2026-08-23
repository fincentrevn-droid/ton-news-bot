import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next === source) {
    console.log(`${label}: already applied`);
    return;
  }
  await writeFile(path, next);
  console.log(label);
}

// Cost guard should be based on actual AI calls. The generated-post counter is
// diagnostic and includes candidates later rejected by QC, so using it as a hard
// stop can leave the public channel at 0-1 posts while the internal counter is full.
await patch(
  "artifacts/api-server/src/lib/openai.ts",
  (input) => {
    if (input.includes("AUTOPUBLISH_AI_CALL_BUDGET_ONLY")) return input;
    const oldBlock = `  if (usage.postsGenerated >= settings.maxPostsPerDay) {\n    return {\n      blocked: true,\n      reason: \`⚠️ Daily post limit reached (\${usage.postsGenerated}/\${settings.maxPostsPerDay}). Generation stopped.\`,\n    };\n  }\n  return { blocked: false };`;
    const replacement = `  // AUTOPUBLISH_AI_CALL_BUDGET_ONLY: rejected/QC-review candidates must not\n  // consume the public posting capacity. Public maxPostsPerDay is enforced by\n  // the scheduler; cost is guarded by maxAiCallsPerDay above.\n  return { blocked: false };`;
    if (!input.includes(oldBlock)) throw new Error("AI generated-post hard limit block not found");
    return input.replace(oldBlock, replacement);
  },
  "Removed generated-draft counter as an autopublish hard stop",
);

await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    let s = input;

    // The scheduler had a second generated-post hard stop in addition to the
    // OpenAI cost guard. Remove it for the same reason.
    if (!s.includes("SCHEDULER_AI_CALL_BUDGET_ONLY")) {
      s = s.replace(
        'import { checkAiLimitReached, getOrCreateTodayUsage, getSettings } from "./openai";',
        'import { checkAiLimitReached } from "./openai";',
      );
      const oldGuard = `  // Check daily post count from AI usage table\n  const [usage, settings] = await Promise.all([getOrCreateTodayUsage(), getSettings()]);\n  if (usage.postsGenerated >= settings.maxPostsPerDay) {\n    logger.debug({ generated: usage.postsGenerated, max: settings.maxPostsPerDay }, "Scheduler: daily post limit — skipping generation");\n    return;\n  }\n\n`;
      if (!s.includes(oldGuard)) throw new Error("scheduler generated-post hard limit block not found");
      s = s.replace(
        oldGuard,
        `  // SCHEDULER_AI_CALL_BUDGET_ONLY: public daily cap is enforced by\n  // countPublishedToday(); rejected drafts do not stop source rotation.\n\n`,
      );
    }

    // Retry quickly not only when generation returns null/error, but also when a
    // generated post fails auto-publish QC and is routed to manual review.
    if (!s.includes("AUTO_REVIEW_SHORT_RETRY")) {
      const oldThen = `  generateAndQueuePost(notifyOwner)\n    .then((result) => {\n      if (result) {\n        logger.info({ postId: result.postId, queued: result.queued, qc: result.qualityScore }, "Scheduler: auto-generation completed");\n      } else {\n        const cooldownMinutes = Math.max(minMinutesBetweenPosts, 75);\n        lastAutoGenerateAttemptMs = Date.now() - Math.max(0, cooldownMinutes - AUTO_GENERATE_RETRY_MINUTES) * 60 * 1000;\n        logger.info({ retryInMin: AUTO_GENERATE_RETRY_MINUTES }, "Scheduler: auto-generation returned no post; short retry scheduled");\n      }\n    })`;
      const newThen = `  generateAndQueuePost(notifyOwner)\n    .then((result) => {\n      if (result?.queued) {\n        logger.info({ postId: result.postId, queued: true, qc: result.qualityScore }, "Scheduler: auto-generation queued an eligible post");\n      } else {\n        // AUTO_REVIEW_SHORT_RETRY: null and QC-review results both mean there is\n        // still nothing eligible for autopublish. Rotate sources again soon.\n        lastAutoGenerateAttemptMs = Date.now() - AUTO_GENERATE_RETRY_MINUTES * 60 * 1000;\n        logger.info(\n          { postId: result?.postId, queued: result?.queued ?? false, retryInMin: AUTO_GENERATE_RETRY_MINUTES },\n          "Scheduler: no eligible queued post; short retry scheduled",\n        );\n      }\n    })`;
      if (!s.includes(oldThen)) throw new Error("scheduler generation completion block not found after reliability patch");
      s = s.replace(oldThen, newThen);
    }

    // PANKOFF legacy hardening used 30 min and shared reliability used 20 min.
    // Normalize either form to 10 min for source/QC rotation. This does NOT
    // shorten the real minimum spacing between successfully published posts.
    const retryConst = /const AUTO_GENERATE_RETRY_MINUTES = Math\.max\(5, Number\.parseInt\(process\.env\.AUTO_GENERATE_RETRY_MINUTES \?\? "\d+", 10\) \|\| \d+\);/;
    if (!retryConst.test(s)) throw new Error("AUTO_GENERATE_RETRY_MINUTES constant not found");
    s = s.replace(
      retryConst,
      'const AUTO_GENERATE_RETRY_MINUTES = Math.max(5, Number.parseInt(process.env.AUTO_GENERATE_RETRY_MINUTES ?? "10", 10) || 10);',
    );

    // Generation is source preparation, not publication. The old scheduler put
    // the publish-spacing return before queue inspection, so after one successful
    // post it would not even search/generate the next candidate for 75+ minutes.
    // Move spacing to immediately before Telegram send. If the queue has no
    // eligible draft, generation is allowed to run on its own short retry cadence.
    if (!s.includes("AUTOPUBLISH_PREPARE_AHEAD")) {
      const spacingStart = s.indexOf("    // Minimum spacing check");
      const queueStart = s.indexOf("    // Find the oldest queued draft ready for auto-publish", spacingStart);
      if (spacingStart < 0 || queueStart < 0) throw new Error("publish spacing block not found");

      const spacingBlock = s.slice(spacingStart, queueStart);
      s = s.slice(0, spacingStart) + s.slice(queueStart);

      const publishMarker = "    // ── Publish the queued post";
      const publishAt = s.indexOf(publishMarker);
      if (publishAt < 0) throw new Error("publish marker not found");

      const relocatedSpacing = spacingBlock.replace(
        "    // Minimum spacing check (only applies to publishing, not generation trigger)",
        "    // AUTOPUBLISH_PREPARE_AHEAD: spacing applies only to Telegram publish, never source preparation",
      );
      s = s.slice(0, publishAt) + relocatedSpacing + s.slice(publishAt);
    }

    // The base cooldown itself must also be independent from publish spacing.
    // Otherwise the first rejected candidate after a restart can still block
    // source rotation for 75+ minutes before the short-retry adjustment runs.
    const legacyCooldown = "  const cooldownMs = Math.max(minMinutesBetweenPosts, 75) * 60 * 1000;";
    if (s.includes(legacyCooldown)) {
      s = s.replace(
        legacyCooldown,
        "  const cooldownMs = AUTO_GENERATE_RETRY_MINUTES * 60 * 1000; // AUTOPUBLISH_GENERATION_COOLDOWN",
      );
    }

    return s;
  },
  "Made natural scheduler prepare candidates independently from publish spacing",
);

// FINCENTRE deduplicates only published material by design. When QC rejects a
// business candidate, quarantine that source hash temporarily too; otherwise the
// next natural scheduler attempt can pick the same weak item again.
await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    if (!input.includes("FINCENTRE_NO_POST_TTL_MS") || input.includes("FINCENTRE_QC_REJECT_TTL")) return input;
    const marker = `  const routeToQueue =\n    autoPublishEnabled &&\n    qualifies &&\n    qualityOk &&\n    sourceAgeOk &&\n    cryptoBodyAssessment.accepted;`;
    if (!input.includes(marker)) throw new Error("routeToQueue block not found for FINCENTRE QC quarantine");
    return input.replace(
      marker,
      `${marker}\n\n  // FINCENTRE_QC_REJECT_TTL: do not let one QC-rejected source monopolize\n  // natural scheduler attempts. Manual review remains available for the draft.\n  if (!cryptoProfile && !routeToQueue) {\n    fincentreNoPostUntil.set(candidate.textHash, Date.now() + FINCENTRE_NO_POST_TTL_MS);\n  }`,
    );
  },
  "Quarantined FINCENTRE QC-rejected sources from immediate retry",
);

console.log("Natural autopost throughput hardening complete");
