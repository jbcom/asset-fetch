import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface ExpectedFile {
  size: number;
  md5?: string;
}

/** Verify size and optional MD5 without loading a potentially huge asset into memory. */
export function fileMatches(path: string, expected: ExpectedFile): boolean {
  try {
    const descriptor = openSync(path, "r");
    try {
      if (fstatSync(descriptor).size !== expected.size) return false;
      if (!expected.md5) return true;
      // Compatibility checksum supplied by the asset service, not authentication.
      const hash = createHash("md5");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let bytesRead: number;
      do {
        bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
      return hash.digest("hex").toLowerCase() === expected.md5.toLowerCase();
    } finally {
      closeSync(descriptor);
    }
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
