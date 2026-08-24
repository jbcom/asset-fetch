import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve ITCH_API_KEY: process.env first, then a `.env` file in the given
 * root (a gitignored convention — `ITCH_API_KEY=<key>`).
 * Returns undefined rather than throwing so callers can print their own
 * contextual error message.
 */
export function readItchApiKey(root: string): string | undefined {
  if (process.env.ITCH_API_KEY) return process.env.ITCH_API_KEY;
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return undefined;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^ITCH_API_KEY=(\S+)/);
    if (match) return match[1];
  }
  return undefined;
}
