import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fileMatches, requireHttpsUrl } from "../src/integrity.js";

describe("integrity helpers", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "asset-fetch-integrity-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("checks size and optional MD5 without throwing for missing files", () => {
    const path = join(root, "asset.bin");
    writeFileSync(path, "asset");
    const checksum = createHash("md5").update("asset").digest("hex");
    expect(fileMatches(path, { size: 5 })).toBe(true);
    expect(fileMatches(path, { size: 4 })).toBe(false);
    expect(fileMatches(path, { size: 5, md5: checksum.toUpperCase() })).toBe(true);
    expect(fileMatches(path, { size: 5, md5: "00000000000000000000000000000000" })).toBe(false);
    expect(fileMatches(join(root, "missing"), { size: 0 })).toBe(false);
  });

  test("accepts only valid HTTPS URLs", () => {
    expect(requireHttpsUrl("https://example.com/file").hostname).toBe("example.com");
    expect(() => requireHttpsUrl("not a url", "asset URL")).toThrow(/not a valid URL/);
    expect(() => requireHttpsUrl("http://example.com", "asset URL")).toThrow(/must use https/);
  });
});
