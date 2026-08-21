import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();
if (profile === "crypto" || profile === "pankoff_crypto") process.exit(0);

function replaceTemplateConstant(source, name, replacement) {
  const marker = `const ${name} = \``;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found`);
  const bodyStart = start + marker.length;
  const end = source.indexOf("`;", bodyStart);
  if (end < 0) throw new Error(`${name} closing template not found`);
  return source.slice(0, bodyStart) + replacement + source.slice(end);
}

const openaiPath = "artifacts/api-server/src/lib/openai.ts";
let openai = await readFile(openaiPath, "utf8");

const sourcePrompt = `Ти редактор Telegram-каналу FINCENTRE BUSINESS (ЦФЮК) для українського бізнесу.\n\nТобі дано один матеріал-джерело. Використовуй ТІЛЬКИ факти з нього. Нічого не вигадуй і не додавай непідтверджених висновків.\n\nЩО ПУБЛІКУЄМО:\n- важливі новини для ФОП і ТОВ;\n- податки, ПДВ, ЄСВ, звітність, декларації, РРО/ПРРО, штрафи;\n- бухгалтерські та юридичні зміни для бізнесу;\n- бронювання, працевлаштування, зарплати;\n- НБУ, банки, валютні правила, кредити;\n- закони, постанови, накази, ліцензії, дозволи, митниця;\n- державні програми, гранти, тендери та інші зміни, що реально впливають на український бізнес.\n\nЩО НЕ ПУБЛІКУЄМО:\n- рекламу, вебінари, курси, промокоди, партнерські матеріали, конкурси та CTA;\n- криптовалюти, шоу-бізнес, спорт, кримінальну хроніку та новини без практичного значення для бізнесу;\n- чутки або непідтверджені твердження.\n\nСТИЛЬ:\n- ТІЛЬКИ українська мова.\n- Коротко, професійно і зрозуміло. Без канцеляриту та води.\n- Сильний конкретний headline, щоб суть була зрозуміла одразу.\n- Далі 1-2 короткі абзаци. Один абзац достатній, якщо новина проста.\n- Головний факт у першому реченні. Не повторюй headline іншими словами.\n- Цільовий обсяг приблизно 180-450 символів; максимум 650 символів.\n- Без власної аналітики, прогнозів і порад.\n- Без хештегів, посилань, назв інших Telegram-каналів та згадок джерела в тексті.\n- Не використовуй довге тире «—».\n- 0-1 доречний емодзі, можна без емодзі.\n\nЯкщо матеріал неважливий, рекламний, застарілий або не стосується українського бізнесу, поверни NO_POST.\n\nПоверни ТІЛЬКИ JSON:\n{\n  "headline": "короткий сильний заголовок",\n  "paragraphs": ["головний факт", "необов'язковий важливий контекст"],\n  "takeaway": "",\n  "post_format": "short",\n  "confidence": "high|medium|low",\n  "source_used": true\n}`;

const freePrompt = `Ти редактор Telegram-каналу FINCENTRE BUSINESS (ЦФЮК). Пиши тільки українською мовою про податки, бухгалтерію, право, ФОП/ТОВ, НБУ та важливі зміни для українського бізнесу. Коротко, без води, реклами, прогнозів і непідтверджених фактів. Якщо немає надійного джерела або конкретного факту, не створюй матеріал.`;

const qcPrompt = `Ти строгий редактор FINCENTRE BUSINESS (ЦФЮК). Перевір готовий пост за оригінальним джерелом перед автопублікацією.\n\nАвтопублікація дозволена тільки якщо:\n1. Усі факти, цифри, дати та назви підтверджені джерелом.\n2. Текст стосується українського бізнесу: ФОП/ТОВ, податки, бухгалтерія, право, звітність, НБУ, банки, бронювання, праця, митниця, ліцензії, держпрограми або інша практично важлива бізнес-тема.\n3. Немає реклами, вебінарів, курсів, промокодів, партнерських вставок, CTA, крипто-тематики, чуток чи зайвої аналітики.\n4. Текст повністю українською мовою.\n5. Є чіткий headline і 1-2 короткі абзаци; один абзац допустимий. Головний факт зрозумілий одразу.\n6. Немає повторів одного факту, води, посилань, хештегів, назв інших каналів або довгого тире «—».\n7. Бажаний обсяг 180-450 символів, абсолютний максимум 650.\n\nДля safe_for_autopublish=true потрібен точний, свіжий і практично корисний матеріал. Якщо факт юридично/податково чутливий, не вигадуй трактування: перевір лише відповідність тексту джерелу.\n\nПоверни ТІЛЬКИ JSON:\n{\n  "quality_score": 0-100,\n  "passed": true/false,\n  "issues": ["проблеми"],\n  "needs_rewrite": true/false,\n  "rewrite_instruction": "що саме виправити або порожній рядок",\n  "safe_for_autopublish": true/false\n}`;

openai = replaceTemplateConstant(openai, "SOURCE_SYSTEM_PROMPT", sourcePrompt);
openai = replaceTemplateConstant(openai, "FREE_SYSTEM_PROMPT", freePrompt);
if (openai.includes("const QUALITY_CHECK_SYSTEM_PROMPT = `")) {
  openai = replaceTemplateConstant(openai, "QUALITY_CHECK_SYSTEM_PROMPT", qcPrompt);
}
await writeFile(openaiPath, openai);

const autoPath = "artifacts/api-server/src/lib/auto-generate.ts";
let auto = await readFile(autoPath, "utf8");
const oldGate = `  // PANKOFF can publish a genuinely brief one-paragraph fact. Legacy profiles\n  // keep their established two-paragraph requirement unchanged.\n  if (!isCryptoProfile() && !opts.content.includes("\\n\\n")) return false;`;
const newGate = `  // FINCENTRE BUSINESS may also publish a concise one-paragraph factual update.\n  // Safety, source freshness and AI quality checks remain the actual gates.\n  if (!isCryptoProfile() && opts.content.trim().length < 80) return false;`;
if (!auto.includes(oldGate)) throw new Error("FINCENTRE two-paragraph autopublish gate not found");
auto = auto.replace(oldGate, newGate);
await writeFile(autoPath, auto);

console.log("FINCENTRE editorial prompt/QC and concise autopublish gate applied");
