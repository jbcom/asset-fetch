import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type SpawnSyncResult = { status: number | null; stdout?: string; stderr?: string };
type SpawnSyncHandler = (cmd: string, args?: string[]) => SpawnSyncResult;

// node:child_process is a native ESM module — vi.spyOn cannot redefine its
// exports ("Cannot redefine property"), so the spawnSync call is routed
// through a mutable handler installed per test, mocked once at module load.
let spawnSyncHandler: SpawnSyncHandler = () => ({ status: 0 });
const spawnSyncCalls: Array<{ cmd: string; args?: string[] }> = [];
let unrarHandler:
  | ((options: { filepath: string; targetPath: string }) => Promise<unknown>)
  | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: string, args?: string[]) => {
      spawnSyncCalls.push({ cmd, args });
      return spawnSyncHandler(cmd, args);
    },
  };
});

vi.mock("node-unrar-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-unrar-js")>();
  return {
    ...actual,
    createExtractorFromFile: (options: { filepath: string; targetPath: string }) =>
      unrarHandler ? unrarHandler(options) : actual.createExtractorFromFile(options),
  };
});

function useSpawnSync(handler: SpawnSyncHandler): void {
  spawnSyncHandler = handler;
}

function calledWith(cmd: string): Array<{ cmd: string; args?: string[] }> {
  return spawnSyncCalls.filter((c) => c.cmd === cmd);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

const { extractArchives, fetchItchAssets, slugify } = await import("../src/fetch.js");

beforeEach(() => {
  spawnSyncCalls.length = 0;
  spawnSyncHandler = () => ({ status: 0 });
  unrarHandler = undefined;
});

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
    const md5 = (await import("node:crypto")).createHash("md5").update(content).digest("hex");

    mkdirSync(archivesDir, { recursive: true });
    writeFileSync(join(archivesDir, "test-pack-1__pack.zip"), content);

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

  test("treats a missing `uploads` field on the response the same as an empty list", async () => {
    // uploadsResp?.uploads ?? [] — the response object exists but omits
    // `uploads` entirely, exercising the ?? [] fallback rather than an
    // already-empty array.
    const apiGetImpl = async () => ({});
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "No Uploads Field" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl,
    });
    expect(result.failed).toBe(1);
  });

  test("treats an upload with no filename as matching neither archive nor loose patterns", async () => {
    // u.filename ?? "" — an upload missing `filename` falls through both
    // ARCHIVE_RE and LOOSE_RE tests via the empty-string fallback, so the
    // pack ends up with zero usable uploads.
    const apiGetImpl = async () => ({ uploads: [{ id: 1, size: 10 }] });
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Nameless Upload" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl,
    });
    expect(result.failed).toBe(1);
  });

  test("dry run on a loose (non-archive) upload counts it downloaded without touching `archives`", async () => {
    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "cue.wav", size: 5 }] };
      }
      return { url: "https://example.com/cue.wav" };
    };
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Dry Loose Cue" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl,
    });
    expect(result.downloaded).toBe(1);
    expect(result.archives).toEqual([]);
  });

  test("skipping an already-present loose (non-archive) file leaves `archives` empty", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");
    const packSlug = "loose-skip-pack-1";
    const content = Buffer.from("already have this");
    mkdirSync(join(looseDir, packSlug), { recursive: true });
    writeFileSync(join(looseDir, packSlug, "cue.wav"), content);

    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "cue.wav", size: content.length }] };
      }
      throw new Error("should not need a download URL when the file is already correct");
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Loose Skip Pack" }],
      archivesDir,
      looseDir,
      apiGetImpl,
    });

    expect(result.skipped).toBe(1);
    expect(result.archives).toEqual([]);
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

  test("retries an apiGetImpl-less call using the default (unmocked) sleep before giving up", async () => {
    vi.useFakeTimers();
    try {
      const apiGetImpl = async (path: string) => {
        if (path.includes("/uploads")) {
          throw new Error("always fails");
        }
        return { url: "https://example.com/signed" };
      };

      const promise = fetchItchAssets({
        apiKey: "key",
        packs: [{ keyId: 1, gameId: 1, title: "No Sleep Override" }],
        archivesDir: join(dir, "archives"),
        looseDir: join(dir, "loose"),
        dry: true,
        apiGetImpl,
      });

      // No retrySleepImpl -> withApiRetry's real setTimeout-based default
      // sleepImpl runs; fake timers let this settle without a real wait.
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.failed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("downloads for real (non-dry), writing the verified file to disk", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");
    const content = "zip contents";

    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "pack.zip", size: content.length }] };
      }
      return { url: "https://example.com/signed.zip" };
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Real Download" }],
      archivesDir,
      looseDir,
      apiGetImpl,
      downloadImpl: async (_url, destination) => writeFileSync(destination, content),
    });

    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(join(archivesDir, "real-download-1__pack.zip"))).toBe(true);
  });

  test("uses the built-in API client and streaming downloader", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");
    const content = "native fetch archive";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/uploads?")) {
        return jsonResponse({ uploads: [{ id: 9, filename: "pack.zip", size: content.length }] });
      }
      if (url.includes("/download?")) {
        return jsonResponse({ url: "https://cdn.example/native.zip" });
      }
      return new Response(content);
    }) as unknown as typeof fetch;

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 2, title: "Native Fetch" }],
      archivesDir,
      looseDir,
      fetchImpl,
    });

    expect(result).toMatchObject({ downloaded: 1, failed: 0 });
    expect(readFileSync(join(archivesDir, "native-fetch-2__pack.zip"), "utf8")).toBe(content);
  });

  test("keeps an existing destination intact when its replacement download fails", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");
    mkdirSync(archivesDir, { recursive: true });
    const destination = join(archivesDir, "preserved-1__pack.zip");
    writeFileSync(destination, "previous archive");

    const apiGetImpl = async (path: string) =>
      path.includes("/uploads")
        ? { uploads: [{ id: 1, filename: "pack.zip", size: 99 }] }
        : { url: "https://example.com/signed.zip" };
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Preserved" }],
      archivesDir,
      looseDir,
      apiGetImpl,
      downloadImpl: async () => {
        throw new Error("download failed");
      },
    });

    expect(result).toMatchObject({ downloaded: 0, failed: 1 });
    expect(readFileSync(destination, "utf8")).toBe("previous archive");
    expect(readdirSync(archivesDir).some((name) => name.startsWith(".asset-fetch-"))).toBe(false);
  });

  test("rejects a same-size download whose MD5 is wrong and removes its temporary file", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");
    const apiGetImpl = async (path: string) =>
      path.includes("/uploads")
        ? {
            uploads: [
              {
                id: 1,
                filename: "pack.zip",
                size: 4,
                md5_hash: "00000000000000000000000000000000",
              },
            ],
          }
        : { url: "https://example.com/signed.zip" };
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Wrong Hash" }],
      archivesDir,
      looseDir,
      apiGetImpl,
      downloadImpl: async (_url, destination) => writeFileSync(destination, "same"),
    });

    expect(result.failed).toBe(1);
    expect(existsSync(join(archivesDir, "wrong-hash-1__pack.zip"))).toBe(false);
    expect(readdirSync(archivesDir)).toEqual([]);
  });

  test("uses game ids to keep otherwise-colliding title slugs separate", async () => {
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [
        { keyId: 1, gameId: 10, title: "Same Pack" },
        { keyId: 2, gameId: 20, title: "Same--Pack" },
      ],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl: async () => ({ uploads: [{ id: 1, filename: "pack.zip", size: 1 }] }),
    });

    expect(result.archives.map((path) => path.split("/").pop())).toEqual([
      "same-pack-10__pack.zip",
      "same-pack-20__pack.zip",
    ]);
  });

  test("falls back to a readable pack prefix when a title has no ASCII slug", async () => {
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 42, title: "!!!" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      apiGetImpl: async () => ({ uploads: [{ id: 1, filename: "pack.zip", size: 1 }] }),
    });
    expect(result.archives[0]).toMatch(/pack-42__pack\.zip$/);
  });

  test("turns an exception from the download transport into a counted failure", async () => {
    const apiGetImpl = async (path: string) =>
      path.includes("/uploads")
        ? { uploads: [{ id: 1, filename: "pack.zip", size: 1 }] }
        : { url: "https://example.com/pack.zip" };
    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Throws" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      apiGetImpl,
      downloadImpl: async () => {
        throw new Error("transport failed");
      },
    });
    expect(result.failed).toBe(1);
  });

  test("marks a pack failed when the download URL is not https", async () => {
    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "pack.zip", size: 10 }] };
      }
      return { url: "http://insecure.example.com/pack.zip" };
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Insecure Pack" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      apiGetImpl,
    });

    expect(result.failed).toBe(1);
    expect(result.downloaded).toBe(0);
  });

  test("marks a pack failed when the download URL is missing entirely", async () => {
    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "pack.zip", size: 10 }] };
      }
      return {};
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "No URL Pack" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      apiGetImpl,
    });

    expect(result.failed).toBe(1);
  });

  test("marks a pack failed when the download URL request throws", async () => {
    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "pack.zip", size: 10 }] };
      }
      throw new Error("network blip");
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Download URL Throws" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      apiGetImpl,
      retrySleepImpl: async () => {},
    });

    expect(result.failed).toBe(1);
  });

  test("marks a pack failed when the download transport writes a size-mismatched file", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");

    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "pack.zip", size: 999 }] };
      }
      return { url: "https://example.com/signed.zip" };
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Mismatched Size" }],
      archivesDir,
      looseDir,
      apiGetImpl,
      downloadImpl: async (_url, destination) => writeFileSync(destination, "short"),
    });

    expect(result.failed).toBe(1);
    expect(result.downloaded).toBe(0);
  });

  test("routes loose (non-archive) uploads into a per-pack subdirectory of looseDir", async () => {
    const archivesDir = join(dir, "archives");
    const looseDir = join(dir, "loose");

    const apiGetImpl = async (path: string) => {
      if (path.includes("/uploads")) {
        return { uploads: [{ id: 1, filename: "cue.wav", size: 5 }] };
      }
      return { url: "https://example.com/cue.wav" };
    };

    const result = await fetchItchAssets({
      apiKey: "key",
      packs: [{ keyId: 1, gameId: 1, title: "Loose Cue" }],
      archivesDir,
      looseDir,
      apiGetImpl,
      downloadImpl: async (_url, destination) => writeFileSync(destination, "aaaaa"),
    });

    expect(result.downloaded).toBe(1);
    expect(existsSync(join(looseDir, "loose-cue-1", "cue.wav"))).toBe(true);
  });
});

describe("fetchItchAssets default API transport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "itch-fetch-default-apiget-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses fetch with a bearer token when no apiGetImpl is injected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ uploads: [] })) as unknown as typeof fetch;

    const result = await fetchItchAssets({
      apiKey: "real-key",
      packs: [{ keyId: 1, gameId: 1, title: "Default ApiGet" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      fetchImpl,
    });
    expect(result.failed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/uploads?download_key_id=1"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer real-key" }),
      })
    );
  });

  test("defaultApiGet handles HTTP failures", async () => {
    const result = await fetchItchAssets({
      apiKey: "real-key",
      packs: [{ keyId: 1, gameId: 1, title: "Curl Fails" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      retrySleepImpl: async () => {},
      fetchImpl: (async () =>
        new Response("no", { status: 503, statusText: "Unavailable" })) as typeof fetch,
    });
    expect(result.failed).toBe(1);
  });

  test("defaultApiGet handles a non-JSON response", async () => {
    const result = await fetchItchAssets({
      apiKey: "real-key",
      packs: [{ keyId: 1, gameId: 1, title: "Bad JSON" }],
      archivesDir: join(dir, "archives"),
      looseDir: join(dir, "loose"),
      dry: true,
      retrySleepImpl: async () => {},
      fetchImpl: (async () => new Response("not json")) as typeof fetch,
    });
    expect(result.failed).toBe(1);
  });
});

describe("extractArchives", () => {
  let dir: string;
  let archivesDir: string;
  let extractedDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "itch-extract-test-"));
    archivesDir = join(dir, "archives");
    extractedDir = join(dir, "extracted");
    mkdirSync(archivesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("extracts a .zip archive via the system unzip", async () => {
    writeFileSync(join(archivesDir, "my-pack.zip"), "fake zip bytes");
    useSpawnSync(() => ({ status: 0 }));

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.extracted).toEqual(["my-pack"]);
    expect(result.failed).toEqual([]);
    const unzipCalls = calledWith("unzip");
    expect(unzipCalls.length).toBe(2);
    expect(unzipCalls[0]?.args).toEqual(expect.arrayContaining(["-Z1"]));
    expect(unzipCalls[1]?.args).toEqual(expect.arrayContaining(["-q", "-o"]));
    expect(existsSync(join(extractedDir, "my-pack"))).toBe(true);
  });

  test("extracts a .7z archive via the system 7z", async () => {
    writeFileSync(join(archivesDir, "seven.7z"), "fake 7z bytes");
    useSpawnSync(() => ({ status: 0 }));

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.extracted).toEqual(["seven"]);
    const sevenZipCalls = calledWith("7z");
    expect(sevenZipCalls.length).toBe(2);
    expect(sevenZipCalls[0]?.args).toEqual(expect.arrayContaining(["l", "-slt"]));
    expect(sevenZipCalls[1]?.args).toEqual(expect.arrayContaining(["x", "-y"]));
  });

  test("extracts a .rar archive via node-unrar-js", async () => {
    // A syntactically-invalid rar is fine here: node-unrar-js will throw,
    // which exercises the catch-and-record-as-failed path — real behavior
    // for a corrupt/unsupported archive, without needing a real .rar fixture.
    writeFileSync(join(archivesDir, "compressed.rar"), "not a real rar");

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.failed).toEqual(["compressed.rar"]);
  });

  test("validates and extracts a rar archive through node-unrar-js", async () => {
    writeFileSync(join(archivesDir, "valid.rar"), "mock rar");
    const extractedNames: string[] = [];
    unrarHandler = async ({ targetPath }) => ({
      getFileList: () => ({
        fileHeaders: (function* () {
          yield { name: "nested/cue.wav" };
        })(),
      }),
      extract: () => ({
        files: (function* () {
          mkdirSync(join(targetPath, "nested"), { recursive: true });
          writeFileSync(join(targetPath, "nested", "cue.wav"), "audio");
          extractedNames.push("nested/cue.wav");
          yield { fileHeader: { name: "nested/cue.wav" } };
        })(),
      }),
    });

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.extracted).toEqual(["valid"]);
    expect(extractedNames).toEqual(["nested/cue.wav"]);
    expect(existsSync(join(extractedDir, "valid", "nested", "cue.wav"))).toBe(true);
  });

  test("skips non-archive files in archivesDir", async () => {
    writeFileSync(join(archivesDir, "readme.txt"), "not an archive");

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.extracted).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("skips an archive already extracted at least as recently as its source mtime", async () => {
    const archivePath = join(archivesDir, "cached.zip");
    writeFileSync(archivePath, "fake zip bytes");
    useSpawnSync(() => ({ status: 0 }));

    await extractArchives(archivesDir, extractedDir);
    spawnSyncCalls.length = 0;

    // Second run: target dir already exists and is not older than the
    // archive, so it must be skipped without invoking unzip again.
    const second = await extractArchives(archivesDir, extractedDir);
    expect(second.extracted).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(spawnSyncCalls).toEqual([]);
  });

  test("records a failure when the extractor throws (e.g. missing 7z on PATH)", async () => {
    writeFileSync(join(archivesDir, "broken.zip"), "fake zip bytes");
    useSpawnSync(() => {
      throw new Error("spawnSync ENOENT");
    });

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.failed).toEqual(["broken.zip"]);
    expect(result.extracted).toEqual([]);
  });

  test("records non-zero extraction exits as failures and retries them on the next run", async () => {
    writeFileSync(join(archivesDir, "retry.zip"), "fake zip bytes");
    useSpawnSync((_cmd, args) => ({ status: args?.includes("-Z1") ? 0 : 2 }));

    const first = await extractArchives(archivesDir, extractedDir);
    expect(first.failed).toEqual(["retry.zip"]);
    expect(existsSync(join(extractedDir, "retry"))).toBe(false);

    spawnSyncCalls.length = 0;
    useSpawnSync(() => ({ status: 0 }));
    const second = await extractArchives(archivesDir, extractedDir);
    expect(second.extracted).toEqual(["retry"]);
    expect(calledWith("unzip")).toHaveLength(2);
  });

  test("records a zip listing failure before extraction", async () => {
    writeFileSync(join(archivesDir, "bad-list.zip"), "fake zip bytes");
    useSpawnSync(() => ({ status: 3 }));
    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.failed).toEqual(["bad-list.zip"]);
    expect(calledWith("unzip")).toHaveLength(1);
  });

  test("handles 7z listing and extraction failures, and parses safe listed entries", async () => {
    const archive = join(archivesDir, "listed.7z");
    writeFileSync(archive, "fake 7z bytes");

    useSpawnSync((_cmd, args) => (args?.[0] === "l" ? { status: 4, stdout: "" } : { status: 0 }));
    expect((await extractArchives(archivesDir, extractedDir)).failed).toEqual(["listed.7z"]);

    useSpawnSync((_cmd, args) =>
      args?.[0] === "l"
        ? { status: 0, stdout: "metadata\n----------\nPath = nested/cue.wav\n" }
        : { status: 5 }
    );
    expect((await extractArchives(archivesDir, extractedDir)).failed).toEqual(["listed.7z"]);

    useSpawnSync((_cmd, args) =>
      args?.[0] === "l"
        ? { status: 0, stdout: "metadata\n----------\nPath = nested/cue.wav\n" }
        : { status: 0 }
    );
    expect((await extractArchives(archivesDir, extractedDir)).extracted).toEqual(["listed"]);
  });

  test("uses an archive fallback slug when the filename stem has no ASCII characters", async () => {
    writeFileSync(join(archivesDir, "!!!.zip"), "fake zip bytes");
    useSpawnSync(() => ({ status: 0 }));
    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.extracted).toEqual(["archive"]);
  });

  test("rejects traversal paths before invoking the zip extractor", async () => {
    writeFileSync(join(archivesDir, "unsafe.zip"), "fake zip bytes");
    useSpawnSync((_cmd, args) =>
      args?.includes("-Z1") ? { status: 0, stdout: "../outside.wav\n" } : { status: 0 }
    );

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.failed).toEqual(["unsafe.zip"]);
    expect(calledWith("unzip")).toHaveLength(1);
    expect(existsSync(join(dir, "outside.wav"))).toBe(false);
  });
});
