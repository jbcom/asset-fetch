import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fetchItchAssets, slugify } from "../src/fetch.js";

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    expect(slugify("UI Sound Effects Pack – 40 Sounds")).toBe("ui-sound-effects-pack-40-sounds");
  });

  test("strips leading/trailing hyphens", () => {
    expect(slugify("  Weird!! Title??  ")).toBe("weird-title");
  });
});

describe("fetchItchAssets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "itch-fetch-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry run reports without touching disk", async () => {
    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "pack.zip", size: 100, md5_hash: "abc" }] };
      }
      return { url: "https://example.com/signed" };
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Test Pack" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl,
    });

    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);
  });

  test("skips a file already present with matching size+md5", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");
    const content = Buffer.from("fake archive contents");
    const md5 = (await import("node:crypto"))
      .createHash("md5")
      .update(content)
      .digest("hex");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(archivesDir, { recursive: true });
    writeFileSync(join(archivesDir, "test-pack__pack.zip"), content);

    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return {
          uploads: [{ id: 1, filename: "pack.zip", size: content.length, md5_hash: md5 }],
        };
      }
      throw new Error("should not need a download URL when the file is already correct");
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Test Pack" }],
      archivesDir,
      looseDir,
      apiGetImpl,
    });

    expect(result.skipped).toBe(1);
    expect(result.downloaded).toBe(0);
  });

  test("marks a pack failed when no usable uploads exist", async () => {
    const apiGetImpl = async () => ({ uploads: [] });
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Empty Pack" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl,
    });
    expect(result.failed).toBe(1);
  });

  test("retries a transient apiGet failure and recovers within the same pack", async () => {
    let attempts = 0;
    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        attempts++;
        if (attempts < 3) throw new Error("simulated transient network failure");
        return { uploads: [{ id: 1, filename: "pack.zip", size: 100, md5_hash: "abc" }] };
      }
      return { url: "https://example.com/signed" };
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Flaky Pack" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl,
      retrySleepImpl: async () => {},
    });

    expect(attempts).toBe(3);
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);
  });

  test("one pack's exhausted retries doesn't abort the rest of the batch", async () => {
    const apiGetImpl = async (path: string) => {
      if (path.includes("game/1/")) throw new Error("always fails");
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 2, filename: "pack.zip", size: 100, md5_hash: "abc" }] };
      }
      return { url: "https://example.com/signed" };
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [
        { keyId: 1, gameId: 1, title: "Always Fails" },
        { keyId: 2, gameId: 2, title: "Succeeds" },
      ],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl,
      retrySleepImpl: async () => {},
    });

    expect(result.failed).toBe(1);
    expect(result.downloaded).toBe(1);
  });
});
