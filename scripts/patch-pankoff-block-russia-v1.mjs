import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();
if (profile !== "crypto" && profile !== "pankoff_crypto") process.exit(0);

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

// Hard deterministic gate. It runs before generation, so Russia-related source
// items do not consume AI calls, and it also runs on the final public body so a
// queued/manual draft cannot bypass the policy later.
await patch(
  "artifacts/api-server/src/lib/crypto-policy.ts",
  (input) => {
    if (input.includes("PANKOFF_BLOCK_RUSSIA_TOPICS")) return input;
    let s = input;

    const patternMarker = "const PUBLIC_LINK_OR_HANDLE =";
    if (!s.includes(patternMarker)) throw new Error("crypto policy pattern marker not found");
    const block = `// PANKOFF_BLOCK_RUSSIA_TOPICS\n// Editorial policy: do not publish news whose subject is Russia, Russian state\n// institutions/officials, Russian markets/currency or the Russian crypto sector.\nconst RUSSIA_TOPIC_PATTERNS = [\n  /\\b(?:russia|russian|kremlin|putin|moscow|ruble|rouble)\\b/i,\n  /(?:росси(?:я|и|ю|ей|йск\\w*|ян\\w*)|російськ\\w*|росі(?:я|ї|ю|єю))/iu,\n  /(?:кремл\\w*|путин\\w*|путін\\w*|москв\\w*|рубл\\w*|госдум\\w*|росфинмониторинг\\w*)/iu,\n  /(?:bank of russia|moscow exchange|центробанк\\w*[^\\n]{0,40}росси|банк\\w*[^\\n]{0,30}росси)/iu,\n  /(?:^|[^\\p{L}\\p{N}_])рф(?=$|[^\\p{L}\\p{N}_])/iu,\n];\n\n`;
    s = s.replace(patternMarker, block + patternMarker);

    const sourceGate = `  if (hasAny(text, HARD_PROMO_PATTERNS)) reasons.push("реклама, рефералка или опасный CTA");`;
    if (!s.includes(sourceGate)) throw new Error("crypto source hard-promo gate not found");
    s = s.replace(
      sourceGate,
      `  if (hasAny(text, RUSSIA_TOPIC_PATTERNS)) reasons.push("тема России запрещена редакционной политикой PANKOFF");\n${sourceGate}`,
    );

    const publicGate = `  if (hasAny(trimmed, HARD_PROMO_PATTERNS) || hasAny(trimmed, CTA_PATTERNS)) reasons.push("реклама, рефералка или CTA");`;
    if (!s.includes(publicGate)) throw new Error("crypto public body promo gate not found");
    s = s.replace(
      publicGate,
      `  if (hasAny(trimmed, RUSSIA_TOPIC_PATTERNS)) reasons.push("тема России запрещена редакционной политикой PANKOFF");\n${publicGate}`,
    );

    return s;
  },
  "Added deterministic Russia-topic block to PANKOFF crypto policy",
);

// Tell the model/QC the same rule. The deterministic policy above remains the
// source of truth; prompt instructions reduce wasted rewrites and rejected drafts.
await patch(
  "artifacts/api-server/src/lib/openai.ts",
  (input) => {
    if (input.includes("PANKOFF_EDITORIAL_BLOCK_RUSSIA")) return input;
    let s = input;
    const sourceNeedle = "- слухи, неподтверждённые инсайды, старые новости и перепечатки без нового факта: NO_POST.";
    if (!s.includes(sourceNeedle)) throw new Error("PANKOFF source prompt exclusion marker not found");
    s = s.replace(
      sourceNeedle,
      `${sourceNeedle}\n- PANKOFF_EDITORIAL_BLOCK_RUSSIA: любые новости, где Россия/РФ, российские государственные структуры, Путин, Кремль, Москва, рубль или российский крипторынок являются темой события: NO_POST.`,
    );

    const qcNeedle = "11. Больше двух смысловых абзацев после заголовка, больше одного эмодзи, есть длинное тире, ссылка, handle или хэштег.";
    if (!s.includes(qcNeedle)) throw new Error("PANKOFF QC marker not found");
    s = s.replace(
      qcNeedle,
      `${qcNeedle}\n12. Пост касается России/РФ, российских властей, рынков, рубля или российского криптосектора: safe_for_autopublish=false.`,
    );
    return s;
  },
  "Added Russia-topic exclusion to PANKOFF prompts and QC",
);

console.log("PANKOFF Russia-topic filter applied");
