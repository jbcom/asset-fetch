import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listExtractedAudioFiles, promoteAssets, writeAssetManifest } from "../src/promote.js";

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

  test("single-source slot does not get numbered", () => {
    const src = join(dir, "win.ogg");
    writeFileSync(src, "win");
    const targetDir = join(dir, "public");

    promoteAssets({ slots: [{ name: "win-flourish", sources: [src] }], targetDir, apply: true });

    expect(existsSync(join(targetDir, "win-flourish.ogg"))).toBe(true);
  });
});

describe("writeAssetManifest", () => {
  test("writes a manifest.json listing every slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "itch-manifest-test-"));
    try {
      writeAssetManifest(dir, [{ slot: "bark", files: ["bark.wav"], sourceCount: 1 }]);
      const manifestPath = join(dir, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
