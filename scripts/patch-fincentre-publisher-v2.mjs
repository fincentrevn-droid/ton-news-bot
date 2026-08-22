import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();
if (profile === "crypto" || profile === "pankoff_crypto") process.exit(0);

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

// Restore the historical FINCENTRE channel signature at the final publisher
// layer so manual Publish Now, scheduler posts and photo posts are identical.
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (input) => {
    if (input.includes("FINCENTRE_PUBLIC_SIGNATURE")) return input;
    const old = `  // Preserve the legacy publisher byte-for-byte for the business profile.\n  if (!isCryptoProfile()) {\n    return maxVisibleChars === 1024 ? escapeHtml(text).slice(0, 1024) : escapeHtml(text);\n  }`;
    const replacement = `  // FINCENTRE_PUBLIC_SIGNATURE: publisher-level signature for every public path.\n  if (!isCryptoProfile()) {\n    const signature = "@fincentre_business";\n    const clean = text.trim().replace(/\\n{2,}@fincentre_business\\s*$/i, "").trim();\n    const bodyLimit = Math.max(1, maxVisibleChars - signature.length - 2);\n    return \`${'${escapeHtml(truncatePlainText(clean, bodyLimit))}'}\\n\\n${'${signature}'}\`;\n  }`;
    if (!input.includes(old)) throw new Error("FINCENTRE publicPostHtml business block not found");
    return input.replace(old, replacement);
  },
  "Restored FINCENTRE public signature",
);

// Add a one-shot force option used only by the production autopublish test.
// It bypasses clock/spacing/daily timing gates, never quality/safety/profile gates.
await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    if (input.includes("FINCENTRE_AUTOPUBLISH_TEST_FORCE")) return input;
    let s = input;
    const signature = "export async function tickPublisher(): Promise<void> {";
    if (!s.includes(signature)) throw new Error("scheduler tickPublisher signature not found");
    s = s.replace(
      signature,
      `// FINCENTRE_AUTOPUBLISH_TEST_FORCE\nexport async function tickPublisher(options: { force?: boolean; preferredPostId?: number } = {}): Promise<void> {`,
    );
    s = s.replace(
      "    if (!isInActiveWindow(schedule)) {",
      "    if (!options.force && !isInActiveWindow(schedule)) {",
    );
    s = s.replace(
      "    if (todayCount >= schedule.maxPostsPerDay) {",
      "    if (!options.force && todayCount >= schedule.maxPostsPerDay) {",
    );
    s = s.replace(
      "    if (schedule.lastPublishedAt) {",
      "    if (!options.force && schedule.lastPublishedAt) {",
    );
    const oldSelect = "    const post = candidates.find((p) => passesAutoPublishQuality(p));";
    const newSelect = `    const post = options.preferredPostId\n      ? candidates.find((p) => p.id === options.preferredPostId && passesAutoPublishQuality(p))\n      : candidates.find((p) => passesAutoPublishQuality(p));`;
    if (!s.includes(oldSelect)) throw new Error("scheduler candidate selection block not found");
    s = s.replace(oldSelect, newSelect);
    return s;
  },
  "Added FINCENTRE one-shot forced scheduler test",
);

// Production test endpoint: generate with the real source/AI/QC pipeline and let
// the scheduler itself publish the resulting eligible draft immediately.
await patch(
  "artifacts/api-server/src/routes/schedule.ts",
  (input) => {
    if (input.includes("FINCENTRE_TEST_AUTOPUBLISH_ENDPOINT")) return input;
    let s = input;
    s = s.replace(
      'import { db, schedulesTable, settingsTable } from "@workspace/db";',
      'import { db, schedulesTable, settingsTable, postsTable } from "@workspace/db";',
    );
    s = s.replace(
      'import { generateAndQueuePost } from "../lib/auto-generate";',
      'import { generateAndQueuePost } from "../lib/auto-generate";\nimport { tickPublisher } from "../lib/scheduler";',
    );

    const marker = '\nexport { getOrCreateSchedule };';
    if (!s.includes(marker)) throw new Error("schedule route export marker not found");
    const endpoint = `\n// FINCENTRE_TEST_AUTOPUBLISH_ENDPOINT\nrouter.post("/schedule/test-autopublish", async (req, res): Promise<void> => {\n  try {\n    const schedule = await getOrCreateSchedule();\n    if (!schedule.enabled || !schedule.autoPublish) {\n      res.status(409).json({ success: false, message: "Сначала включите Automation и Auto-publish в Schedule" });\n      return;\n    }\n\n    const limitCheck = await checkAiLimitReached();\n    if (limitCheck.blocked) {\n      res.status(429).json({ success: false, message: limitCheck.reason ?? "AI limit reached" });\n      return;\n    }\n\n    const generated = await generateAndQueuePost();\n    if (!generated) {\n      res.status(422).json({ success: false, message: "Свежая подходящая новость не найдена. Автопайплайн работает, но публиковать сейчас нечего." });\n      return;\n    }\n    if (!generated.queued) {\n      res.status(422).json({ success: false, message: \`Пост #\${generated.postId} создан, но QC не допустил его к автопубликации. Он оставлен на review.\` });\n      return;\n    }\n\n    await tickPublisher({ force: true, preferredPostId: generated.postId });\n    const [post] = await db.select().from(postsTable).where(eq(postsTable.id, generated.postId));\n    if (post?.status !== "published") {\n      res.status(409).json({\n        success: false,\n        message: \`Пост #\${generated.postId} прошёл генерацию, но scheduler не подтвердил публикацию. Статус: \${post?.status ?? "unknown"}.\`,\n      });\n      return;\n    }\n\n    res.json({\n      success: true,\n      postId: post.id,\n      telegramMessageId: post.telegramMessageId,\n      message: \`✅ Боевой тест пройден: scheduler сам опубликовал пост #\${post.id}\`,\n    });\n  } catch (err: unknown) {\n    const message = err instanceof Error ? err.message : "Autopublish test failed";\n    req.log.error({ err }, "FINCENTRE autopublish production test failed");\n    res.status(500).json({ success: false, message });\n  }\n});\n`;
    return s.replace(marker, endpoint + marker);
  },
  "Added FINCENTRE production autopublish test endpoint",
);

// Add a dashboard button that invokes the exact production test endpoint.
await patch(
  "artifacts/dashboard/src/pages/schedule.tsx",
  (input) => {
    if (input.includes("FINCENTRE_TEST_AUTOPUBLISH_BUTTON")) return input;
    let s = input;
    s = s.replace('import { useEffect } from "react";', 'import { useEffect, useState } from "react";');
    const hookMarker = '  const { toast } = useToast();';
    if (!s.includes(hookMarker)) throw new Error("schedule dashboard toast hook marker not found");
    s = s.replace(
      hookMarker,
      `${hookMarker}\n  // FINCENTRE_TEST_AUTOPUBLISH_BUTTON\n  const [testingAutoPublish, setTestingAutoPublish] = useState(false);\n\n  const testAutoPublish = async () => {\n    setTestingAutoPublish(true);\n    try {\n      const response = await fetch("/api/schedule/test-autopublish", { method: "POST" });\n      const data = await response.json() as { success?: boolean; message?: string; postId?: number };\n      if (!response.ok || !data.success) throw new Error(data.message ?? "Autopublish test failed");\n      toast({ title: "Автопубликация работает", description: data.message });\n      queryClient.invalidateQueries({ queryKey: getGetScheduleQueryKey() });\n    } catch (err: unknown) {\n      const message = err instanceof Error ? err.message : "Autopublish test failed";\n      toast({ title: "Тест автопубликации не пройден", description: message, variant: "destructive" });\n    } finally {\n      setTestingAutoPublish(false);\n    }\n  };`,
    );

    const statusEnd = `                    <div className="flex justify-between items-center py-2">\n                      <span className="text-muted-foreground">Авто-публикация</span>\n                      <span className={schedule?.autoPublish ? "text-orange-500 font-bold" : "text-muted-foreground"}>\n                        {schedule?.autoPublish ? "ВКЛ" : "ВЫКЛ"}\n                      </span>\n                    </div>\n                  </CardContent>\n                </Card>\n\n                {/* ── Posting window`;
    const statusWithButton = `                    <div className="flex justify-between items-center py-2">\n                      <span className="text-muted-foreground">Авто-публикация</span>\n                      <span className={schedule?.autoPublish ? "text-orange-500 font-bold" : "text-muted-foreground"}>\n                        {schedule?.autoPublish ? "ВКЛ" : "ВЫКЛ"}\n                      </span>\n                    </div>\n                  </CardContent>\n                  <CardFooter className="flex-col gap-2">\n                    <Button\n                      type="button"\n                      variant="outline"\n                      className="w-full"\n                      onClick={testAutoPublish}\n                      disabled={testingAutoPublish || !schedule?.enabled || !schedule?.autoPublish}\n                    >\n                      {testingAutoPublish ? "Проверяю автопубликацию..." : "Test Auto Publish"}\n                    </Button>\n                    <p className="text-xs text-muted-foreground">Один боевой тест: генерация + QC + публикация scheduler без ожидания обычного интервала.</p>\n                  </CardFooter>\n                </Card>\n\n                {/* ── Posting window`;
    if (!s.includes(statusEnd)) throw new Error("schedule dashboard status card marker not found");
    return s.replace(statusEnd, statusWithButton);
  },
  "Added FINCENTRE Test Auto Publish dashboard button",
);

console.log("FINCENTRE publisher/signature/autopublish-test patch complete");
