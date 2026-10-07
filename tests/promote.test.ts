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

type SpawnSyncResult = { status: number | null };
type SpawnSyncHandler = (cmd: string, args?: string[]) => SpawnSyncResult;

// node:child_process is a native ESM module — vi.spyOn cannot redefine its
// exports, so spawnSync is routed through a mutable handler installed per
// test, mocked once at module load time.
let spawnSyncHandler: SpawnSyncHandler = () => ({ status: 0 });

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: string, args?: string[]) => spawnSyncHandler(cmd, args),
  };
});

function useSpawnSync(handler: SpawnSyncHandler): void {
  spawnSyncHandler = handler;
}

const { listExtractedAudioFiles, promoteAssets, writeAssetManifest } = await import(
  "../src/promote.js"
);

beforeEach(() => {
  spawnSyncHandler = () => ({ status: 0 });
});

describe("promoteAssets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "itch-promote-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry run (apply: false) reports without copying", () => {
    const src = join(dir, "source.ogg");
    writeFileSync(src, "fake audio");
    const targetDir = join(dir, "public");

    const result = promoteAssets({
      slots: [{ name: "ambient-pad", sources: [src] }],
      targetDir,
    });

    expect(result.written["ambient-pad"]).toEqual([join(targetDir, "ambient-pad.ogg")]);
    expect(existsSync(join(targetDir, "ambient-pad.ogg"))).toBe(false);
  });

  test("apply: true copies and numbers multi-source slots", () => {
    const src1 = join(dir, "a.wav");
    const src2 = join(dir, "b.wav");
    writeFileSync(src1, "a");
    writeFileSync(src2, "b");
    const targetDir = join(dir, "public");

    const result = promoteAssets({
      slots: [{ name: "bark", sources: [src1, src2] }],
      targetDir,
      apply: true,
    });

    expect(existsSync(join(targetDir, "bark-0.wav"))).toBe(true);
    expect(existsSync(join(targetDir, "bark-1.wav"))).toBe(true);
    expect(result.manifest[0]?.sourceCount).toBe(2);
  });

  test("a source file with no extension falls back to .ogg", () => {
    const src = join(dir, "noext");
    writeFileSync(src, "mystery bytes");
    const targetDir = join(dir, "public");

    const result = promoteAssets({
      slots: [{ name: "mystery", sources: [src] }],
      targetDir,
      apply: true,
    });

    expect(result.written.mystery).toEqual([join(targetDir, "mystery.ogg")]);
    expect(existsSync(join(targetDir, "mystery.ogg"))).toBe(true);
  });

  test("single-source slot does not get numbered", () => {
    const src = join(dir, "win.ogg");
    writeFileSync(src, "win");
    const targetDir = join(dir, "public");

    promoteAssets({ slots: [{ name: "win-flourish", sources: [src] }], targetDir, apply: true });

    expect(existsSync(join(targetDir, "win-flourish.ogg"))).toBe(true);
  });

  test("normalize: true runs ffmpeg and replaces the promoted file with the loudnorm'd output", () => {
    const src = join(dir, "loud.wav");
    writeFileSync(src, "raw audio");
    const targetDir = join(dir, "public");

    useSpawnSync((cmd, args) => {
      if (cmd === "ffmpeg") {
        const normalizedPath = args?.[args.length - 1];
        if (normalizedPath) writeFileSync(normalizedPath, "normalized audio");
      }
      // also covers the "rm -f <normalized>" cleanup spawnSync call
      return { status: 0 };
    });

    promoteAssets({
      slots: [{ name: "loud", sources: [src] }],
      targetDir,
      apply: true,
      normalize: true,
    });

    const dest = join(targetDir, "loud.wav");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("normalized audio");
  });

  test("normalize: true leaves the plain copy in place when ffmpeg fails", () => {
    const src = join(dir, "unnormalized.wav");
    writeFileSync(src, "raw audio");
    const targetDir = join(dir, "public");

    useSpawnSync(() => ({ status: 1 }));

    promoteAssets({
      slots: [{ name: "unnormalized", sources: [src] }],
      targetDir,
      apply: true,
      normalize: true,
    });

    const dest = join(targetDir, "unnormalized.wav");
    expect(existsSync(dest)).toBe(true);
    // ffmpeg "failed" (status 1) -> the original plain copy is left as-is,
    // never overwritten by a normalized file that was never produced.
    expect(readFileSync(dest, "utf8")).toBe("raw audio");
  });

  test("rejects path-like, duplicate, empty, and colliding slots before writing", () => {
    const src = join(dir, "source.wav");
    writeFileSync(src, "audio");
    const targetDir = join(dir, "public");

    expect(() =>
      promoteAssets({ slots: [{ name: "../escape", sources: [src] }], targetDir, apply: true })
    ).toThrow(/invalid slot name/);
    expect(() =>
      promoteAssets({
        slots: [
          { name: "same", sources: [src] },
          { name: "same", sources: [src] },
        ],
        targetDir,
        apply: true,
      })
    ).toThrow(/duplicate slot name/);
    expect(() =>
      promoteAssets({
        slots: [
          { name: "Cue", sources: [src] },
          { name: "cue", sources: [src] },
        ],
        targetDir,
        apply: true,
      })
    ).toThrow(/duplicate slot name/);
    expect(() =>
      promoteAssets({ slots: [{ name: "empty", sources: [] }], targetDir, apply: true })
    ).toThrow(/no source files/);
    expect(() =>
      promoteAssets({
        slots: [
          { name: "bark", sources: [src, src] },
          { name: "bark-0", sources: [src] },
        ],
        targetDir,
        apply: true,
      })
    ).toThrow(/both produce bark-0\.wav/);
    expect(existsSync(targetDir)).toBe(false);
  });

  test("rejects unsupported source extensions", () => {
    const src = join(dir, "not-audio.txt");
    writeFileSync(src, "text");
    expect(() =>
      promoteAssets({ slots: [{ name: "cue", sources: [src] }], targetDir: join(dir, "public") })
    ).toThrow(/unsupported audio extension/);
  });

  test("removes stale numbered variants after a slot shrinks to one source", () => {
    const first = join(dir, "first.wav");
    const second = join(dir, "second.wav");
    writeFileSync(first, "first");
    writeFileSync(second, "second");
    const targetDir = join(dir, "public");

    promoteAssets({ slots: [{ name: "bark", sources: [first, second] }], targetDir, apply: true });
    promoteAssets({ slots: [{ name: "bark", sources: [first] }], targetDir, apply: true });

    expect(readdirSync(targetDir).sort()).toEqual(["bark.wav"]);
  });

  test("stages all sources before replacing existing promoted files", () => {
    const good = join(dir, "good.wav");
    writeFileSync(good, "old");
    const targetDir = join(dir, "public");
    promoteAssets({ slots: [{ name: "cue", sources: [good] }], targetDir, apply: true });

    expect(() =>
      promoteAssets({
        slots: [{ name: "cue", sources: [join(dir, "missing.wav")] }],
        targetDir,
        apply: true,
      })
    ).toThrow();

    expect(readFileSync(join(targetDir, "cue.wav"), "utf8")).toBe("old");
    expect(readdirSync(targetDir)).toEqual(["cue.wav"]);
  });
});

describe("writeAssetManifest", () => {
  test("writes a manifest.json with a real generatedAt timestamp and every slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "itch-manifest-test-"));
    try {
      const before = Date.now();
      writeAssetManifest(dir, [{ slot: "bark", files: ["bark.wav"], sourceCount: 1 }]);
      const after = Date.now();

      const manifestPath = join(dir, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);

      const written = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(written.slots).toEqual([{ slot: "bark", files: ["bark.wav"], sourceCount: 1 }]);
      expect(typeof written.generatedAt).toBe("string");
      const parsedTime = Date.parse(written.generatedAt);
      expect(parsedTime).toBeGreaterThanOrEqual(before);
      expect(parsedTime).toBeLessThanOrEqual(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the target directory and leaves no temporary artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "itch-manifest-create-test-"));
    const target = join(root, "nested", "audio");
    try {
      writeAssetManifest(target, []);
      expect(readdirSync(target)).toEqual(["manifest.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("listExtractedAudioFiles", () => {
  test("recursively finds audio files, ignoring other extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "itch-list-test-"));
    try {
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "a.wav"), "a");
      writeFileSync(join(dir, "nested", "b.ogg"), "b");
      writeFileSync(join(dir, "readme.txt"), "not audio");

      const files = listExtractedAudioFiles(dir);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith("a.wav"))).toBe(true);
      expect(files.some((f) => f.endsWith("b.ogg"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
