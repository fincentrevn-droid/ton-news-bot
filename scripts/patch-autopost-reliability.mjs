import { readFile, writeFile } from "node:fs/promises";

const path = "artifacts/api-server/src/lib/scheduler.ts";
let source = await readFile(path, "utf8");
let changed = false;

function replaceOnce(from, to, label) {
  if (!source.includes(from)) return false;
  source = source.replace(from, to);
  changed = true;
  console.log(label);
  return true;
}

// A small set of stale/unpublishable drafts must not hide a newer eligible one.
if (!source.includes("AUTOPUBLISH_DEEP_QUEUE_SCAN")) {
  const oldQueue = `    const candidates = await db\n      .select()\n      .from(postsTable)\n      .where(and(eq(postsTable.status, "draft"), isNull(postsTable.reviewMessageId)))\n      .orderBy(postsTable.createdAt)\n      .limit(10);`;
  const newQueue = `    // AUTOPUBLISH_DEEP_QUEUE_SCAN: old rejected drafts must not starve newer good posts.\n    const candidates = await db\n      .select()\n      .from(postsTable)\n      .where(and(eq(postsTable.status, "draft"), isNull(postsTable.reviewMessageId)))\n      .orderBy(postsTable.createdAt)\n      .limit(100);`;
  if (!replaceOnce(oldQueue, newQueue, "Expanded scheduler eligible-draft scan to 100 posts")) {
    // PANKOFF runtime hardening may have inserted comments around the same query.
    const queueLimit = ".orderBy(postsTable.createdAt)\n      .limit(10);";
    if (source.includes(queueLimit)) {
      source = source.replace(
        queueLimit,
        ".orderBy(postsTable.createdAt)\n      // AUTOPUBLISH_DEEP_QUEUE_SCAN\n      .limit(100);",
      );
      changed = true;
      console.log("Expanded hardened scheduler eligible-draft scan to 100 posts");
    }
  }
}

// Business originally waited the full 75+ minute generation cooldown even when
// every source returned NO_POST. PANKOFF already has a short retry patch; keep it.
if (!source.includes("AUTO_GENERATE_RETRY_MINUTES")) {
  replaceOnce(
    "let autoGenerateInProgress = false;",
    `let autoGenerateInProgress = false;\nconst AUTO_GENERATE_RETRY_MINUTES = Math.max(5, Number.parseInt(process.env.AUTO_GENERATE_RETRY_MINUTES ?? "20", 10) || 20);`,
    "Added short no-post generation retry",
  );
}

if (!source.includes("short retry scheduled")) {
  replaceOnce(
    `      } else {\n        logger.info("Scheduler: auto-generation returned no post (no sources or all NO_POST)");\n      }`,
    `      } else {\n        const cooldownMinutes = Math.max(minMinutesBetweenPosts, 75);\n        lastAutoGenerateAttemptMs = Date.now() - Math.max(0, cooldownMinutes - AUTO_GENERATE_RETRY_MINUTES) * 60 * 1000;\n        logger.info({ retryInMin: AUTO_GENERATE_RETRY_MINUTES }, "Scheduler: auto-generation returned no post; short retry scheduled");\n      }`,
    "Shortened retry after empty generation cycle",
  );
}

// A transient OpenAI/Telegram/source error must not silence the scheduler for 75 minutes.
if (!source.includes("AUTO_GENERATE_ERROR_RETRY_MINUTES")) {
  const anchor = source.includes("const AUTO_GENERATE_RETRY_MINUTES")
    ? /const AUTO_GENERATE_RETRY_MINUTES[^\n]*;/
    : /let autoGenerateInProgress = false;/;
  const match = source.match(anchor);
  if (match) {
    source = source.replace(
      match[0],
      `${match[0]}\nconst AUTO_GENERATE_ERROR_RETRY_MINUTES = Math.max(5, Number.parseInt(process.env.AUTO_GENERATE_ERROR_RETRY_MINUTES ?? "10", 10) || 10);`,
    );
    changed = true;
    console.log("Added short retry after generation errors");
  }
}

if (!source.includes("generation failed; short retry scheduled")) {
  replaceOnce(
    `    .catch((err) => {\n      logger.error({ err }, "Scheduler: auto-generation failed");\n    })`,
    `    .catch((err) => {\n      const cooldownMinutes = Math.max(minMinutesBetweenPosts, 75);\n      lastAutoGenerateAttemptMs = Date.now() - Math.max(0, cooldownMinutes - AUTO_GENERATE_ERROR_RETRY_MINUTES) * 60 * 1000;\n      logger.error({ err, retryInMin: AUTO_GENERATE_ERROR_RETRY_MINUTES }, "Scheduler: generation failed; short retry scheduled");\n    })`,
    "Shortened retry after generation failure",
  );
}

if (changed) {
  await writeFile(path, source);
} else {
  console.log("Shared scheduler reliability hardening already applied");
}
