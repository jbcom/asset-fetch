import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeKey } from "./safety.js";

/**
 * Resolve ITCH_API_KEY: process.env first, then a `.env` file in the given
 * root (a gitignored convention — `ITCH_API_KEY=<key>`).
 *
 * Every candidate passes through {@link sanitizeKey}, the single gate between
 * a configured value and the `Authorization` header: a value of the wrong
 * shape is skipped, never sent. Returns undefined rather than throwing, for a
 * missing and a malformed key alike, so callers can print their own contextual
 * error message.
 */
export function readItchApiKey(root: string): string | undefined {
  const fromEnvironment = sanitizeKey(process.env.ITCH_API_KEY);
  if (fromEnvironment) return fromEnvironment;
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return undefined;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?ITCH_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = String(match[1]);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    const key = sanitizeKey(value);
    if (key) return key;
  }
  return undefined;
}
