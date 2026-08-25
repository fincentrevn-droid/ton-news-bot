import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();
const cryptoProfile = profile === "crypto" || profile === "pankoff_crypto";

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

// 1) FINCENTRE deferred Telegram photos were detected but never downloaded.
// Load only the selected candidate after AI selection, run business image safety,
// then reuse the same buffer for queue pre-upload or manual review.
if (!cryptoProfile) {
  await patch(
    "artifacts/api-server/src/lib/auto-generate.ts",
    (input) => {
      let s = input;
      if (!s.includes('import { assessBusinessImageSafety } from "./media-safety";')) {
        s = s.replace(
          'import { inspectCryptoMedia } from "./crypto-media-safety";',
          'import { inspectCryptoMedia } from "./crypto-media-safety";\nimport { assessBusinessImageSafety } from "./media-safety";',
        );
      }

      if (!s.includes("FINCENTRE_SELECTED_MEDIA_LOAD")) {
        const marker = "  const safety = checkSafety(content);";
        if (!s.includes(marker)) throw new Error("auto-generate safety marker not found");
        const block = `  // FINCENTRE_SELECTED_MEDIA_LOAD: deferred Telegram media is downloaded only\n  // after this source actually produced the chosen article. A bad image is dropped\n  // without rejecting the text post.\n  let selectedMediaBuffer: Buffer | undefined = candidate.mediaBuffer;\n  let businessMediaStatus: string | null = null;\n  if (!cryptoProfile && candidate.mediaType === "photo") {\n    if (!selectedMediaBuffer && candidate.mediaLoader) {\n      try {\n        selectedMediaBuffer = await candidate.mediaLoader();\n      } catch (err) {\n        logger.warn({ err, channel: candidate.channel }, "Business source media download failed; keeping text-only post");\n      }\n    }\n\n    if (selectedMediaBuffer) {\n      try {\n        const decision = await assessBusinessImageSafety({\n          buffer: selectedMediaBuffer,\n          sourceChannel: candidate.channel,\n          sourceText: candidate.fullText,\n        });\n        businessMediaStatus = decision.allowed ? "visual_safe" : \`visual_rejected:\${decision.reason}\`;\n        if (!decision.allowed) {\n          logger.info(\n            { channel: candidate.channel, reason: decision.reason },\n            "Business source photo rejected; retaining text-only post",\n          );\n          selectedMediaBuffer = undefined;\n        } else {\n          logger.info(\n            { channel: candidate.channel, bytes: selectedMediaBuffer.length },\n            "Business source photo approved for publication",\n          );\n        }\n      } catch (err) {\n        businessMediaStatus = "visual_scan_failed";\n        selectedMediaBuffer = undefined;\n        logger.warn({ err, channel: candidate.channel }, "Business visual media scan failed; retaining text-only post");\n      }\n    } else {\n      businessMediaStatus = "download_failed";\n    }\n  }\n\n`;
        s = s.replace(marker, block + marker);
      }

      s = s.replace(
        '  const hasMedia = candidate.mediaType === "photo" && Boolean(candidate.mediaBuffer) && mediaAssessment.accepted;',
        '  const hasMedia = candidate.mediaType === "photo" && Boolean(selectedMediaBuffer) && mediaAssessment.accepted;',
      );
      s = s.replace(
        '  if (routeToQueue && hasMedia && candidate.mediaBuffer) {\n    try {\n      preUploadedFileId = await uploadPhotoGetFileId(candidate.mediaBuffer);',
        '  if (routeToQueue && hasMedia && selectedMediaBuffer) {\n    try {\n      preUploadedFileId = await uploadPhotoGetFileId(selectedMediaBuffer);',
      );
      s = s.replace(
        '      mediaDownloadStatus: cryptoProfile && candidate.mediaType === "photo"\n        ? (hasMedia ? "visual_safe" : "visual_rejected")\n        : (hasMedia ? "ok" : null),',
        '      mediaDownloadStatus: cryptoProfile && candidate.mediaType === "photo"\n        ? (hasMedia ? "visual_safe" : "visual_rejected")\n        : (candidate.mediaType === "photo" ? (hasMedia ? "visual_safe" : businessMediaStatus) : null),',
      );
      s = s.replace(
        '    hasMedia ? candidate.mediaBuffer : undefined,',
        '    hasMedia ? selectedMediaBuffer : undefined,',
      );
      return s;
    },
    "Connected FINCENTRE deferred media loader and image safety",
  );

  // FINCENTRE OCR should use the actually installed traineddata instead of
  // rejecting every image if one optional language pack is missing on Railway.
  await patch(
    "artifacts/api-server/src/lib/media-safety.ts",
    (input) => {
      let s = input;
      if (!s.includes("FINCENTRE_DYNAMIC_OCR_LANGS")) {
        const old = `  const ocrResult = await runMediaTool(\n    "tesseract",\n    ["stdin", "stdout", "-l", "eng+ukr+rus", "--psm", "11", "tsv"],\n    buffer,\n  );`;
        const replacement = `  // FINCENTRE_DYNAMIC_OCR_LANGS\n  const langProbe = await runMediaTool("tesseract", ["--list-langs"], Buffer.alloc(0));\n  if (langProbe.failed || langProbe.code !== 0) {\n    return { allowed: false, reason: "ocr_failed", ...metadata };\n  }\n  const availableLanguages = new Set(\n    langProbe.stdout.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean),\n  );\n  const selectedLanguages = ["eng", "ukr", "rus"].filter((lang) => availableLanguages.has(lang));\n  if (selectedLanguages.length === 0) {\n    return { allowed: false, reason: "ocr_failed", ...metadata };\n  }\n\n  const ocrResult = await runMediaTool(\n    "tesseract",\n    ["stdin", "stdout", "-l", selectedLanguages.join("+"), "--psm", "11", "tsv"],\n    buffer,\n  );`;
        if (!s.includes(old)) throw new Error("FINCENTRE OCR language block not found");
        s = s.replace(old, replacement);
      }

      // The source's own logo is allowed; known foreign media/channel branding
      // remains blocked. This avoids rejecting a clean official source photo.
      const oldBrand = `  if (\n    sourceTokens.some((token) => recognizedTokens.includes(token)) ||\n    recognizedTokens.some((token) =>\n      KNOWN_MEDIA_BRANDS.has(token.replace(/^@/, "")),\n    )\n  ) {`;
      const newBrand = `  const foreignKnownBrand = recognizedTokens.some((token) => {\n    const cleanToken = token.replace(/^@/, "");\n    return KNOWN_MEDIA_BRANDS.has(cleanToken) && !sourceTokens.includes(cleanToken);\n  });\n  if (foreignKnownBrand) {`;
      if (s.includes(oldBrand)) s = s.replace(oldBrand, newBrand);

      const oldEdge = `    const token = normalizeText(word.text);\n    if (token.length < 4) return false;`;
      const newEdge = `    const token = normalizeText(word.text);\n    if (token.length < 4 || sourceTokens.includes(token.replace(/^@/, ""))) return false;`;
      if (s.includes(oldEdge)) s = s.replace(oldEdge, newEdge);
      return s;
    },
    "Made FINCENTRE media safety runtime-compatible without allowing foreign branding",
  );
}

// 2) Queue pre-upload should use the same review-chat fallback as review messages.
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (input) => {
    if (input.includes("MEDIA_PREUPLOAD_CHAT_FALLBACK")) return input;
    const old = `  const token = getBotToken();\n  const chatId = process.env.REVIEW_CHAT_ID;\n  if (!chatId) throw new Error("REVIEW_CHAT_ID not set — cannot pre-upload media");`;
    const replacement = `  const token = getBotToken();\n  // MEDIA_PREUPLOAD_CHAT_FALLBACK: staging media can use OWNER_TELEGRAM_ID too,\n  // matching the existing review-message behavior.\n  const chatId = getReviewChatId();\n  if (!chatId) throw new Error("REVIEW_CHAT_ID/OWNER_TELEGRAM_ID not set — cannot pre-upload media");`;
    if (!input.includes(old)) throw new Error("uploadPhotoGetFileId chat block not found");
    return input.replace(old, replacement);
  },
  "Added safe review-chat fallback for media pre-upload",
);

// 3) Do not silently downgrade a safe photo candidate to public text-only when
// Telegram staging fails. Route it to review, where the original buffer can still
// be uploaded and produce a reusable file_id. This applies to both profiles.
await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    let s = input;
    if (s.includes("MEDIA_STAGE_FAILURE_TO_REVIEW")) return s;
    s = s.replace("  const routeToQueue =\n", "  let routeToQueue =\n");
    const old = `    } catch (err) {\n      logger.warn({ err }, "Failed to pre-upload media for queued post — will publish as text");\n    }`;
    const replacement = `    } catch (err) {\n      // MEDIA_STAGE_FAILURE_TO_REVIEW\n      routeToQueue = false;\n      logger.warn({ err }, "Failed to pre-upload media for queued post; routing to review with the source photo");\n    }`;
    if (!s.includes(old)) {
      throw new Error("queued media pre-upload failure block not found");
    }
    return s.replace(old, replacement);
  },
  "Prevented silent photo-to-text downgrade when queue staging fails",
);

// 4) PANKOFF ImageMagick normalization had a convert fallback only on the first
// command; the OCR-prep command called `magick` directly and therefore rejected
// every image on Railway images where only `convert` is exposed.
if (cryptoProfile) {
  await patch(
    "artifacts/api-server/src/lib/crypto-media-safety.ts",
    (input) => {
      if (input.includes("CRYPTO_IMAGEMAGICK_OCR_FALLBACK")) return input;
      const old = `    await execFileAsync("magick", [\n      normalizedPath,\n      "-colorspace",\n      "Gray",\n      "-contrast-stretch",\n      "0x15%",\n      ocrPath,\n    ]);`;
      const replacement = `    // CRYPTO_IMAGEMAGICK_OCR_FALLBACK\n    const ocrArgs = [\n      normalizedPath,\n      "-colorspace",\n      "Gray",\n      "-contrast-stretch",\n      "0x15%",\n      ocrPath,\n    ];\n    try {\n      await execFileAsync("magick", ocrArgs);\n    } catch (err) {\n      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;\n      await execFileAsync("convert", ocrArgs);\n    }`;
      if (!input.includes(old)) throw new Error("crypto OCR ImageMagick command not found");
      return input.replace(old, replacement);
    },
    "Added ImageMagick fallback to PANKOFF OCR preparation",
  );
}

// 5) FINCENTRE dashboard Publish Now must honor an already staged mediaFileId.
// Scheduler and Telegram-review paths already know how to publish photos.
if (!cryptoProfile) {
  await patch(
    "artifacts/api-server/src/routes/posts.ts",
    (input) => {
      let s = input;
      if (!s.includes('sendPhotoPost')) {
        s = s.replace(
          'import { sendTelegramMessage, sendReviewMessage, notifyOwner } from "../lib/telegram";',
          'import { sendTelegramMessage, sendPhotoPost, sendReviewMessage, notifyOwner } from "../lib/telegram";',
        );
      }
      if (s.includes("FINCENTRE_DASHBOARD_MEDIA_PUBLISH")) return s;
      const old = `  try {\n    const messageId = await sendTelegramMessage(post.content);\n    const [updated] = await db\n      .update(postsTable)\n      .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })`;
      const replacement = `  try {\n    // FINCENTRE_DASHBOARD_MEDIA_PUBLISH\n    const messageId = post.hasMedia && post.mediaFileId\n      ? (await sendPhotoPost(post.mediaFileId, post.content)).messageId\n      : await sendTelegramMessage(post.content);\n    const [updated] = await db\n      .update(postsTable)\n      .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })`;
      if (!s.includes(old)) throw new Error("FINCENTRE dashboard publish block not found");
      return s.replace(old, replacement);
    },
    "Made FINCENTRE dashboard Publish Now media-aware",
  );
}

console.log(`Shared media pipeline hardening complete for ${cryptoProfile ? "crypto" : "business"}`);
