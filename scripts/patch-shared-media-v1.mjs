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

// Shared source -> post media handoff. FINCENTRE uses a deferred mediaLoader,
// while PANKOFF downloads eagerly. Normalize both into selectedMediaBuffer only
// after a source has successfully generated text, so MTProto is not overloaded.
await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    let s = input;
    if (!s.includes('import { assessBusinessImageSafety } from "./media-safety";')) {
      const marker = 'import { inspectCryptoMedia } from "./crypto-media-safety";';
      if (!s.includes(marker)) throw new Error("crypto media import marker not found");
      s = s.replace(marker, `${marker}\nimport { assessBusinessImageSafety } from "./media-safety";`);
    }

    if (!s.includes("SHARED_SELECTED_MEDIA_BUFFER")) {
      const marker = "  const safety = checkSafety(content);";
      if (!s.includes(marker)) throw new Error("post safety marker not found");
      const block = `  // SHARED_SELECTED_MEDIA_BUFFER: resolve the selected source image only after\n  // text generation succeeds. FINCENTRE's reader intentionally defers downloads.\n  let selectedMediaBuffer: Buffer | undefined = candidate.mediaBuffer;\n  let businessMediaStatus: string | null = null;\n\n  if (!cryptoProfile && candidate.mediaType === "photo") {\n    try {\n      if (!selectedMediaBuffer && candidate.mediaLoader) {\n        selectedMediaBuffer = await candidate.mediaLoader();\n      }\n      if (selectedMediaBuffer) {\n        const businessDecision = await assessBusinessImageSafety({\n          buffer: selectedMediaBuffer,\n          sourceChannel: candidate.channel,\n          sourceText: candidate.fullText,\n        });\n        if (!businessDecision.allowed) {\n          businessMediaStatus = \`visual_rejected:\${businessDecision.reason}\`;\n          logger.info(\n            { channel: candidate.channel, reason: businessDecision.reason },\n            "Business source photo rejected by media safety; retaining text-only post",\n          );\n          selectedMediaBuffer = undefined;\n        } else {\n          businessMediaStatus = "visual_safe";\n          logger.info(\n            { channel: candidate.channel, bytes: selectedMediaBuffer.length },\n            "Business source photo approved and attached",\n          );\n        }\n      } else {\n        businessMediaStatus = "download_failed";\n        logger.info({ channel: candidate.channel }, "Business source photo detected but download returned no buffer");\n      }\n    } catch (err) {\n      businessMediaStatus = "scan_failed";\n      selectedMediaBuffer = undefined;\n      logger.warn({ err, channel: candidate.channel }, "Business source photo processing failed; retaining text-only post");\n    }\n  }\n\n`;
      s = s.replace(marker, block + marker);
    }

    s = s.replace(
      'const hasMedia = candidate.mediaType === "photo" && Boolean(candidate.mediaBuffer) && mediaAssessment.accepted;',
      'const hasMedia = candidate.mediaType === "photo" && Boolean(selectedMediaBuffer) && mediaAssessment.accepted;',
    );

    s = s.replace(
      'if (routeToQueue && hasMedia && candidate.mediaBuffer) {',
      'if (routeToQueue && hasMedia && selectedMediaBuffer) {',
    );
    s = s.replace(
      'preUploadedFileId = await uploadPhotoGetFileId(candidate.mediaBuffer);',
      'preUploadedFileId = await uploadPhotoGetFileId(selectedMediaBuffer);',
    );
    s = s.replace(
      'hasMedia ? candidate.mediaBuffer : undefined,',
      'hasMedia ? selectedMediaBuffer : undefined,',
    );

    // Do not silently downgrade a photo-ready queued post to text when staging
    // fails. Route it to review instead; sendReviewMessage still has the raw buffer
    // and can obtain a Telegram file_id there.
    s = s.replace(
      '  const routeToQueue =\n',
      '  let routeToQueue =\n',
    );
    const oldCatch = `    } catch (err) {\n      logger.warn({ err }, "Failed to pre-upload media for queued post — will publish as text");\n    }`;
    const newCatch = `    } catch (err) {\n      routeToQueue = false;\n      logger.warn({ err }, "Failed to pre-upload media for queued post; routing to review with photo buffer");\n    }`;
    if (s.includes(oldCatch)) s = s.replace(oldCatch, newCatch);

    // Preserve a useful status for both profiles. Scheduler still requires
    // visual_safe only for crypto; business uses hasMedia + mediaFileId.
    const oldStatus = `      mediaDownloadStatus: cryptoProfile && candidate.mediaType === "photo"\n        ? (hasMedia ? "visual_safe" : "visual_rejected")\n        : (hasMedia ? "ok" : null),`;
    const newStatus = `      mediaDownloadStatus: cryptoProfile && candidate.mediaType === "photo"\n        ? (hasMedia ? "visual_safe" : "visual_rejected")\n        : (candidate.mediaType === "photo" ? (businessMediaStatus ?? (hasMedia ? "visual_safe" : "visual_rejected")) : null),`;
    if (s.includes(oldStatus)) s = s.replace(oldStatus, newStatus);

    return s;
  },
  "Connected selected-source media to generation, safety, staging and review",
);

// Queue media staging should use the same review-chat fallback as ordinary review.
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (input) => {
    let s = input;
    if (!s.includes("SHARED_MEDIA_REVIEW_CHAT_FALLBACK")) {
      const old = `  const chatId = process.env.REVIEW_CHAT_ID;\n  if (!chatId) throw new Error("REVIEW_CHAT_ID not set — cannot pre-upload media");`;
      const replacement = `  // SHARED_MEDIA_REVIEW_CHAT_FALLBACK\n  const chatId = getReviewChatId();\n  if (!chatId) throw new Error("No REVIEW_CHAT_ID or OWNER_TELEGRAM_ID set — cannot pre-upload media");`;
      if (!s.includes(old)) throw new Error("uploadPhotoGetFileId review chat block not found");
      s = s.replace(old, replacement);
    }
    return s;
  },
  "Added OWNER_TELEGRAM_ID fallback for queued photo staging",
);

// FINCENTRE dashboard Publish Now historically ignored media even when a file_id
// existed. Make the final manual path photo-aware; PANKOFF already has its own
// stronger atomic publisher patch and is intentionally left unchanged here.
if (!cryptoProfile) {
  await patch(
    "artifacts/api-server/src/routes/posts.ts",
    (input) => {
      let s = input;
      if (s.includes("FINCENTRE_DASHBOARD_MEDIA_PUBLISH")) return s;
      s = s.replace(
        'import { sendTelegramMessage, sendReviewMessage, notifyOwner } from "../lib/telegram";',
        'import { sendTelegramMessage, sendPhotoPost, sendReviewMessage, notifyOwner } from "../lib/telegram";',
      );
      const old = `  try {\n    const messageId = await sendTelegramMessage(post.content);\n    const [updated] = await db\n      .update(postsTable)`;
      const replacement = `  try {\n    // FINCENTRE_DASHBOARD_MEDIA_PUBLISH\n    const messageId = post.hasMedia && post.mediaFileId\n      ? (await sendPhotoPost(post.mediaFileId, post.content)).messageId\n      : await sendTelegramMessage(post.content);\n    const [updated] = await db\n      .update(postsTable)`;
      if (!s.includes(old)) throw new Error("FINCENTRE dashboard publish block not found");
      return s.replace(old, replacement);
    },
    "Made FINCENTRE dashboard Publish Now photo-aware",
  );
}

// Crypto scanner used a magick->convert fallback only for the first ImageMagick
// operation. Give the OCR-preparation operation the same fallback so Railway can
// work with either ImageMagick 6 or 7 binaries.
if (cryptoProfile) {
  await patch(
    "artifacts/api-server/src/lib/crypto-media-safety.ts",
    (input) => {
      if (input.includes("PANKOFF_IMAGEMAGICK_OCR_FALLBACK")) return input;
      const old = `    await execFileAsync("magick", [\n      normalizedPath,\n      "-colorspace",\n      "Gray",\n      "-contrast-stretch",\n      "0x15%",\n      ocrPath,\n    ]);`;
      const replacement = `    // PANKOFF_IMAGEMAGICK_OCR_FALLBACK\n    const ocrArgs = [\n      normalizedPath,\n      "-colorspace",\n      "Gray",\n      "-contrast-stretch",\n      "0x15%",\n      ocrPath,\n    ];\n    try {\n      await execFileAsync("magick", ocrArgs);\n    } catch (err) {\n      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;\n      await execFileAsync("convert", ocrArgs);\n    }`;
      if (!input.includes(old)) throw new Error("second ImageMagick operation not found");
      return input.replace(old, replacement);
    },
    "Added ImageMagick 6/7 fallback to PANKOFF OCR preparation",
  );
}

// FINCENTRE OCR should use whichever relevant traineddata is actually present in
// Railway rather than failing every image merely because one optional language is
// unavailable. English is preferred, with Ukrainian/Russian added when present.
if (!cryptoProfile) {
  await patch(
    "artifacts/api-server/src/lib/media-safety.ts",
    (input) => {
      let s = input;
      if (s.includes("FINCENTRE_DYNAMIC_OCR_LANGS")) return s;
      const old = `  const ocrResult = await runMediaTool(\n    "tesseract",\n    ["stdin", "stdout", "-l", "eng+ukr+rus", "--psm", "11", "tsv"],\n    buffer,\n  );`;
      const replacement = `  // FINCENTRE_DYNAMIC_OCR_LANGS\n  const langProbe = await runMediaTool("tesseract", ["--list-langs"], Buffer.alloc(0));\n  if (langProbe.failed || langProbe.code !== 0) {\n    return { allowed: false, reason: "ocr_failed", ...metadata };\n  }\n  const availableLanguages = new Set(\n    langProbe.stdout.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean),\n  );\n  const selectedLanguages = ["eng", "ukr", "rus"].filter((lang) => availableLanguages.has(lang));\n  if (selectedLanguages.length === 0) {\n    return { allowed: false, reason: "ocr_failed", ...metadata };\n  }\n\n  const ocrResult = await runMediaTool(\n    "tesseract",\n    ["stdin", "stdout", "-l", selectedLanguages.join("+"), "--psm", "11", "tsv"],\n    buffer,\n  );`;
      if (!s.includes(old)) throw new Error("FINCENTRE fixed OCR language block not found");
      s = s.replace(old, replacement);

      // Allow the current source's own brand token; reject known foreign brands.
      const oldBrand = `  if (\n    sourceTokens.some((token) => recognizedTokens.includes(token)) ||\n    recognizedTokens.some((token) =>\n      KNOWN_MEDIA_BRANDS.has(token.replace(/^@/, "")),\n    )\n  ) {`;
      const newBrand = `  const foreignKnownBrand = recognizedTokens.some((token) => {\n    const cleanToken = token.replace(/^@/, "");\n    return KNOWN_MEDIA_BRANDS.has(cleanToken) && !sourceTokens.includes(cleanToken);\n  });\n  if (foreignKnownBrand) {`;
      if (s.includes(oldBrand)) s = s.replace(oldBrand, newBrand);

      const oldEdge = `    const token = normalizeText(word.text);\n    if (token.length < 4) return false;`;
      const newEdge = `    const token = normalizeText(word.text);\n    if (token.length < 4 || sourceTokens.includes(token.replace(/^@/, ""))) return false;`;
      if (s.includes(oldEdge)) s = s.replace(oldEdge, newEdge);
      return s;
    },
    "Made FINCENTRE business image safety runtime-compatible",
  );
}

console.log(`Shared media pipeline v1 applied for ${cryptoProfile ? "crypto" : "business"}`);
