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

function replaceTemplateConstant(source, name, replacement) {
  const marker = `const ${name} = \``;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found`);
  const bodyStart = start + marker.length;
  const end = source.indexOf("`;", bodyStart);
  if (end < 0) throw new Error(`${name} closing template not found`);
  return source.slice(0, bodyStart) + replacement + source.slice(end);
}

// Editorial v3: fewer routine price snapshots, more actual events, still short.
await patch(
  "artifacts/api-server/src/lib/openai.ts",
  (input) => {
    if (input.includes("PANKOFF_EDITORIAL_V3_TODAY")) return input;

    const sourcePrompt = `Ты редактор Telegram-канала PANKOFF CRYPTO. Пиши только важные, свежие и проверяемые крипто-новости.\n\nPANKOFF_EDITORIAL_V3_TODAY\nТебе дан один источник. Используй ТОЛЬКО подтверждённые факты из него. Ничего не додумывай. Публикация источника должна относиться к сегодняшнему календарному дню по Europe/Kyiv.\n\nГЛАВНЫЙ ПРИНЦИП:\nПост должен отвечать на вопрос «что реально произошло сегодня?», а не просто показывать текущее состояние рынка. Читатель должен понять суть за несколько секунд.\n\nЧТО БЕРЁМ:\n- BTC, ETH и крупные альткоины, если есть конкретное новое событие;\n- ETF, биржи, регулирование, безопасность, взломы, крупные сделки, ликвидации, опционы, стейблкоины, инфраструктура, заметные on-chain события, TON/Telegram;\n- сильные рыночные движения, рекорды или многомесячные экстремумы, если это действительно новый факт сегодняшнего дня;\n- редкие интересные истории, если они проверяемы и имеют отношение к крипторынку.\n\nЧТО НЕ БЕРЁМ:\n- обычный ценовой снимок типа «SOL стоит около $94», «BTC вырос на 3%», список цен нескольких монет или Fear & Greed без отдельного важного события: NO_POST;\n- обычное изменение капитализации рынка без сильного события/рекорда: NO_POST;\n- прогнозы, торговые сигналы, мнение автора, «бычий/медвежий» вывод без конкретного нового факта: NO_POST;\n- рекламу, партнёрки, рефералки, промокоды, казино, конкурсы, курсы, affiliate/ambassador, self-promo, claim/connect wallet и любые CTA: NO_POST;\n- слухи, неподтверждённые инсайды, старые новости и перепечатки без нового факта: NO_POST.\n\nЕсли цена является частью новости, сначала покажи СОБЫТИЕ. Цена может быть headline только если сама является событием: новый значимый максимум/минимум, сильное движение примерно от 5% за короткий период или важный подтверждённый уровень. Не перечисляй цены BTC, ETH, SOL и BNB одним списком.\n\nСТИЛЬ:\n- Только русский язык.\n- Заголовок обязателен: 4-10 слов, конкретное событие + сильная цифра/имя, если есть. Без кликбейта.\n- После заголовка обычно один короткий абзац из 1-2 предложений. Второй абзац только если без него теряется ключевой контекст.\n- Цель: 150-320 символов основного текста. Жёсткий максимум 420 символов вместе с заголовком.\n- В первом предложении: что произошло сегодня. Во втором: ключевая цифра или подтверждённый контекст.\n- Не повторяй headline другими словами. Не делай отдельный финальный вывод. takeaway почти всегда пустой.\n- Не пиши «рынок оживился», «это важный сигнал», «рынок в зоне жадности» как самостоятельную новость.\n- 0-1 обычный эмодзи. Без длинного тире «—», хэштегов, ссылок, handles и подписи источника.\n\nВерни ТОЛЬКО JSON:\n{\n  "headline": "короткий сильный заголовок",\n  "paragraphs": ["главный факт в 1-2 предложениях", "необязательный короткий контекст"],\n  "takeaway": "",\n  "post_format": "short",\n  "confidence": "high|medium|low",\n  "source_used": true\n}\n\nЕсли материал не подходит, верни {"headline":"NO_POST","paragraphs":[],"takeaway":"","post_format":"short","confidence":"low","source_used":false}.`;

    const qcPrompt = `Ты строгий выпускающий редактор PANKOFF CRYPTO. Сравни пост с источником.\n\nPANKOFF_QC_V3_TODAY\nАвтопубликация запрещена, если есть хотя бы одна проблема:\n1. Есть неподтверждённый факт, цифра, дата, причина или вывод.\n2. Новость не относится к сегодняшнему дню по Europe/Kyiv или является старым повтором.\n3. Это обычный price snapshot без отдельного события: текущая цена, небольшой процент движения, список цен, капитализация или Fear & Greed без действительно нового важного факта.\n4. Цена подана как главная новость, хотя в источнике есть более важное событие/причина.\n5. Есть реклама, CTA, рефералка, торговый сигнал, прогноз цены или финансовый совет.\n6. Текст не на русском.\n7. Общая длина больше 420 символов.\n8. Заголовок общий/слабый или повторяет первый абзац.\n9. Одна мысль или цифра повторяется несколько раз.\n10. Есть лишняя аналитика или шаблонный вывод вместо нового факта.\n11. Больше двух смысловых абзацев после заголовка, больше одного эмодзи, есть длинное тире, ссылка, handle или хэштег.\n\nДля score 90+ пост должен ощущаться как реальная сегодняшняя новость: конкретное событие, одна главная цифра/деталь, минимум воды. Если материал можно сократить или он слишком похож на рыночную сводку, needs_rewrite=true или safe_for_autopublish=false.\n\nВерни ТОЛЬКО JSON:\n{\n  "quality_score": 0-100,\n  "passed": true/false,\n  "issues": ["конкретные проблемы"],\n  "needs_rewrite": true/false,\n  "rewrite_instruction": "что именно исправить, без новых фактов",\n  "safe_for_autopublish": true/false\n}`;

    let s = replaceTemplateConstant(input, "PANKOFF_CRYPTO_SOURCE_SYSTEM_PROMPT", sourcePrompt);
    s = replaceTemplateConstant(s, "PANKOFF_CRYPTO_QUALITY_CHECK_SYSTEM_PROMPT", qcPrompt);
    s = s.replace(
      'short: "Формат: SHORT. Для PANKOFF цель 180-350 символов, максимум 450. Сильный headline + главный факт + только необходимый контекст. Без отдельного повторяющего вывода.",',
      'short: "Формат: SHORT. Для PANKOFF цель 150-320 символов, максимум 420. Конкретное сегодняшнее событие + ключевая цифра/деталь. Не публикуй обычный price snapshot.",',
    );
    return s;
  },
  "Applied PANKOFF editorial v3 for event-first news",
);

// Hard today-only source gate using Kyiv calendar date, not a rolling 24h window.
await patch(
  "artifacts/api-server/src/lib/crypto-policy.ts",
  (input) => {
    if (input.includes("PANKOFF_KYIV_TODAY_ONLY")) return input;
    let s = input;
    const helperMarker = "export function cryptoSourceAgeHours(): number {";
    if (!s.includes(helperMarker)) throw new Error("crypto source age helper marker not found");
    const helper = `// PANKOFF_KYIV_TODAY_ONLY\nfunction kyivDateKey(date: Date): string {\n  const parts = new Intl.DateTimeFormat("en-US", {\n    timeZone: "Europe/Kyiv",\n    year: "numeric",\n    month: "2-digit",\n    day: "2-digit",\n  }).formatToParts(date);\n  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "";\n  return \`${'${value("year")}-${value("month")}-${value("day")}'}\`;\n}\n\nexport function isCryptoSourceToday(publishedAt: Date): boolean {\n  return Number.isFinite(publishedAt.getTime()) && kyivDateKey(publishedAt) === kyivDateKey(new Date());\n}\n\n${helperMarker}`;
    s = s.replace(helperMarker, helper);

    const oldAgeGate = `  if (!Number.isFinite(publishedAt.getTime()) || ageMs > cryptoSourceAgeHours() * 60 * 60 * 1000) {\n    reasons.push("устаревший источник");\n  }`;
    const newAgeGate = `  if (!Number.isFinite(publishedAt.getTime()) || !isCryptoSourceToday(publishedAt)) {\n    reasons.push("источник не за сегодня по Киеву");\n  } else if (ageMs > cryptoSourceAgeHours() * 60 * 60 * 1000 || ageMs < -5 * 60 * 1000) {\n    reasons.push("некорректное время источника");\n  }`;
    if (!s.includes(oldAgeGate)) throw new Error("crypto source age gate not found");
    s = s.replace(oldAgeGate, newAgeGate);
    s = s
      .replace("const CRYPTO_MAX_BODY_LENGTH = 450;", "const CRYPTO_MAX_BODY_LENGTH = 420;")
      .replace("const CRYPTO_MAX_BODY_LENGTH = 600;", "const CRYPTO_MAX_BODY_LENGTH = 420;")
      .replace('reasons.push("текст длиннее 450 символов")', 'reasons.push("текст длиннее 420 символов")')
      .replace('reasons.push("текст длиннее 600 символов")', 'reasons.push("текст длиннее 420 символов")');
    return s;
  },
  "Restricted PANKOFF sources to the current Kyiv calendar day",
);

// Apply today-only freshness to queued drafts too and let generation inspect more
// candidates because routine price snapshots are now intentionally rejected.
await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    let s = input;
    if (!s.includes("PANKOFF_TODAY_CANDIDATE_DEPTH")) {
      s = s.replace(
        "  for (let attempt = 0; attempt < Math.min(candidates.length, 5); attempt++) {",
        "  // PANKOFF_TODAY_CANDIDATE_DEPTH: skip routine snapshots and inspect deeper into today's feed.\n  for (let attempt = 0; attempt < Math.min(candidates.length, cryptoProfile ? 10 : 5); attempt++) {",
      );
      s = s.replace(
        ': `⚠️ Нет свежих источников за ${maxSourceAgeHours}ч — пост не создан.`;',
        ': cryptoProfile\n        ? "⚠️ Для PANKOFF сейчас нет подходящих неповторяющихся источников за сегодняшний день по Киеву."\n        : `⚠️ Нет свежих источников за ${maxSourceAgeHours}ч — пост не создан.`;',
      );
    }
    return s;
  },
  "Expanded PANKOFF today candidate search",
);

await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    let s = input;
    if (!s.includes("PANKOFF_SCHEDULER_TODAY_GATE")) {
      s = s.replace(
        'import { assessCryptoPublicBody, cryptoSourceAgeHours } from "./crypto-policy";',
        'import { assessCryptoPublicBody, isCryptoSourceToday } from "./crypto-policy";',
      );
      const oldFresh = `    const sourceAgeMs = cryptoSourceAgeHours() * 60 * 60 * 1000;\n    const sourceIsFresh = Boolean(\n      post.sourceDate && Date.now() - new Date(post.sourceDate).getTime() <= sourceAgeMs,\n    );`;
      const newFresh = `    // PANKOFF_SCHEDULER_TODAY_GATE: never publish a draft sourced on a previous Kyiv date.\n    const sourceIsFresh = Boolean(post.sourceDate && isCryptoSourceToday(new Date(post.sourceDate)));`;
      if (!s.includes(oldFresh)) throw new Error("crypto scheduler freshness block not found");
      s = s.replace(oldFresh, newFresh);
    }

    if (!s.includes("PANKOFF_AUTOPUBLISH_TEST_FORCE")) {
      const signature = "export async function tickPublisher(): Promise<void> {";
      if (!s.includes(signature)) throw new Error("scheduler tickPublisher signature not found");
      s = s.replace(
        signature,
        `// PANKOFF_AUTOPUBLISH_TEST_FORCE\nexport async function tickPublisher(options: { force?: boolean; preferredPostId?: number } = {}): Promise<void> {`,
      );
      s = s.replace("    if (!isInActiveWindow(schedule)) {", "    if (!options.force && !isInActiveWindow(schedule)) {");
      s = s.replace("    if (todayCount >= schedule.maxPostsPerDay) {", "    if (!options.force && todayCount >= schedule.maxPostsPerDay) {");
      s = s.replace("    if (schedule.lastPublishedAt) {", "    if (!options.force && schedule.lastPublishedAt) {");
      const oldSelect = "    const post = candidates.find((p) => passesAutoPublishQuality(p));";
      const newSelect = `    const post = options.preferredPostId\n      ? candidates.find((p) => p.id === options.preferredPostId && passesAutoPublishQuality(p))\n      : candidates.find((p) => passesAutoPublishQuality(p));`;
      if (!s.includes(oldSelect)) throw new Error("scheduler candidate selection block not found");
      s = s.replace(oldSelect, newSelect);
    }
    return s;
  },
  "Added PANKOFF today-only queue gate and one-shot autopublish force",
);

// Same production autopublish test as FINCENTRE, isolated to the crypto runtime.
await patch(
  "artifacts/api-server/src/routes/schedule.ts",
  (input) => {
    if (input.includes("PANKOFF_TEST_AUTOPUBLISH_ENDPOINT")) return input;
    let s = input;
    s = s.replace(
      'import { db, schedulesTable, settingsTable } from "@workspace/db";',
      'import { db, schedulesTable, settingsTable, postsTable } from "@workspace/db";',
    );
    s = s.replace(
      'import { generateAndQueuePost } from "../lib/auto-generate";',
      'import { generateAndQueuePost } from "../lib/auto-generate";\nimport { tickPublisher } from "../lib/scheduler";',
    );
    const marker = "\nexport { getOrCreateSchedule };";
    if (!s.includes(marker)) throw new Error("schedule export marker not found");
    const endpoint = `\n// PANKOFF_TEST_AUTOPUBLISH_ENDPOINT\nrouter.post("/schedule/test-autopublish", async (req, res): Promise<void> => {\n  try {\n    const schedule = await getOrCreateSchedule();\n    if (!schedule.enabled || !schedule.autoPublish) {\n      res.status(409).json({ success: false, message: "Сначала включите Automation и Auto-publish в Schedule" });\n      return;\n    }\n    const limitCheck = await checkAiLimitReached();\n    if (limitCheck.blocked) {\n      res.status(429).json({ success: false, message: limitCheck.reason ?? "AI limit reached" });\n      return;\n    }\n    const generated = await generateAndQueuePost();\n    if (!generated) {\n      res.status(422).json({ success: false, message: "Сегодняшняя подходящая крипто-новость не найдена. Старые новости тест не публикует." });\n      return;\n    }\n    if (!generated.queued) {\n      res.status(422).json({ success: false, message: \`Пост #\${generated.postId} создан, но QC не допустил его к автопубликации. Он оставлен на review.\` });\n      return;\n    }\n    await tickPublisher({ force: true, preferredPostId: generated.postId });\n    const [post] = await db.select().from(postsTable).where(eq(postsTable.id, generated.postId));\n    if (post?.status !== "published") {\n      res.status(409).json({ success: false, message: \`Пост #\${generated.postId} прошёл генерацию, но scheduler не подтвердил публикацию. Статус: \${post?.status ?? "unknown"}.\` });\n      return;\n    }\n    res.json({\n      success: true,\n      postId: post.id,\n      telegramMessageId: post.telegramMessageId,\n      message: \`✅ Боевой тест PANKOFF пройден: scheduler сам опубликовал сегодняшний пост #\${post.id}\`,\n    });\n  } catch (err: unknown) {\n    const message = err instanceof Error ? err.message : "PANKOFF autopublish test failed";\n    req.log.error({ err }, "PANKOFF autopublish production test failed");\n    res.status(500).json({ success: false, message });\n  }\n});\n`;
    return s.replace(marker, endpoint + marker);
  },
  "Added PANKOFF production autopublish test endpoint",
);

await patch(
  "artifacts/dashboard/src/pages/schedule.tsx",
  (input) => {
    if (input.includes("PANKOFF_TEST_AUTOPUBLISH_BUTTON")) return input;
    let s = input;
    s = s.replace('import { useEffect } from "react";', 'import { useEffect, useState } from "react";');
    const hookMarker = "  const { toast } = useToast();";
    if (!s.includes(hookMarker)) throw new Error("dashboard toast hook marker not found");
    s = s.replace(
      hookMarker,
      `${hookMarker}\n  // PANKOFF_TEST_AUTOPUBLISH_BUTTON\n  const [testingAutoPublish, setTestingAutoPublish] = useState(false);\n\n  const testAutoPublish = async () => {\n    setTestingAutoPublish(true);\n    try {\n      const response = await fetch("/api/schedule/test-autopublish", { method: "POST" });\n      const data = await response.json() as { success?: boolean; message?: string; postId?: number };\n      if (!response.ok || !data.success) throw new Error(data.message ?? "Autopublish test failed");\n      toast({ title: "PANKOFF автопубликация работает", description: data.message });\n      queryClient.invalidateQueries({ queryKey: getGetScheduleQueryKey() });\n    } catch (err: unknown) {\n      const message = err instanceof Error ? err.message : "Autopublish test failed";\n      toast({ title: "Тест автопубликации не пройден", description: message, variant: "destructive" });\n    } finally {\n      setTestingAutoPublish(false);\n    }\n  };`,
    );

    const statusEnd = `                    <div className="flex justify-between items-center py-2">\n                      <span className="text-muted-foreground">Авто-публикация</span>\n                      <span className={schedule?.autoPublish ? "text-orange-500 font-bold" : "text-muted-foreground"}>\n                        {schedule?.autoPublish ? "ВКЛ" : "ВЫКЛ"}\n                      </span>\n                    </div>\n                  </CardContent>\n                </Card>\n\n                {/* ── Posting window`;
    const statusWithButton = `                    <div className="flex justify-between items-center py-2">\n                      <span className="text-muted-foreground">Авто-публикация</span>\n                      <span className={schedule?.autoPublish ? "text-orange-500 font-bold" : "text-muted-foreground"}>\n                        {schedule?.autoPublish ? "ВКЛ" : "ВЫКЛ"}\n                      </span>\n                    </div>\n                  </CardContent>\n                  <CardFooter className="flex-col gap-2">\n                    <Button type="button" variant="outline" className="w-full" onClick={testAutoPublish} disabled={testingAutoPublish || !schedule?.enabled || !schedule?.autoPublish}>\n                      {testingAutoPublish ? "Проверяю автопубликацию..." : "Test Auto Publish"}\n                    </Button>\n                    <p className="text-xs text-muted-foreground">Боевой тест: свежая новость за сегодня → AI → QC → scheduler → Telegram, без ожидания обычного интервала.</p>\n                  </CardFooter>\n                </Card>\n\n                {/* ── Posting window`;
    if (!s.includes(statusEnd)) throw new Error("dashboard status card marker not found");
    return s.replace(statusEnd, statusWithButton);
  },
  "Added PANKOFF Test Auto Publish dashboard button",
);

console.log("PANKOFF today-only/editorial/autopublish-test patch complete");
