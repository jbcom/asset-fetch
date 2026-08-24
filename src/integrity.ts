import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface ExpectedFile {
  size: number;
  md5?: string;
}

/** Verify size and optional MD5 without loading a potentially huge asset into memory. */
export function fileMatches(path: string, expected: ExpectedFile): boolean {
  try {
    if (statSync(path).size !== expected.size) return false;
    if (!expected.md5) return true;
    const hash = createHash("md5");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const descriptor = openSync(path, "r");
    try {
      let bytesRead: number;
      do {
        bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      closeSync(descriptor);
    }
    return hash.digest("hex").toLowerCase() === expected.md5.toLowerCase();
  } catch {
    return false;
  }
}

/** Parse an HTTPS URL or throw an actionable validation error. */
export function requireHttpsUrl(value: string, label = "URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  return url;
}
