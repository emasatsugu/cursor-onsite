import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Load a dotenv-style file. Does not override keys already present in process.env. */
export function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Prefer real .env; .env.example fills gaps only.
loadEnvFile(path.join(here, "../.env"));
loadEnvFile(path.join(here, "../.env.example"));

export function shouldUseMockOpenAI(): boolean {
  return process.env.MOCK_OPENAI === "1" || !process.env.OPENAI_API_KEY;
}
