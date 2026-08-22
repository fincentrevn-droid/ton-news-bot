import { readFile, writeFile } from "node:fs/promises";

const path = "artifacts/api-server/src/lib/openai.ts";
const source = await readFile(path, "utf8");

// GPT-5.6 Luna rejects explicit non-default temperature values. Both Railway
// profiles may use Luna, so remove temperature overrides for all profiles and
// rely on the model default. Editorial behaviour is controlled by prompts/QC.
const next = source.replace(/^\s*temperature:\s*[^\n]+\n/gm, "");

if (next === source) {
  console.log("OpenAI temperature overrides already absent");
} else {
  await writeFile(path, next);
  console.log("Removed explicit OpenAI temperature overrides for model compatibility");
}
