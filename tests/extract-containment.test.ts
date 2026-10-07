import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { extractArchives } from "../src/fetch.js";

// These run the real `zip` and `unzip` binaries (nothing mocked), because the
// vector under test is what an actual extractor leaves on disk: a symlink
// member that the lexical archive-name check cannot see.
function hasTool(name: string, args: string[]): boolean {
  return spawnSync(name, args, { stdio: "ignore" }).status === 0;
}

const available =
  process.platform !== "win32" && hasTool("zip", ["-v"]) && hasTool("unzip", ["-v"]);

describe.skipIf(!available)("extractArchives against real zip archives", () => {
  let dir: string;
  let archivesDir: string;
  let extractedDir: string;
  let outsideDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asset-fetch-containment-"));
    archivesDir = join(dir, "archives");
    extractedDir = join(dir, "extracted");
    outsideDir = join(dir, "outside");
    mkdirSync(archivesDir);
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.txt"), "not part of the pack");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildArchive(name: string, build: (sourceDir: string) => void, members: string[]): void {
    const sourceDir = mkdtempSync(join(dir, "source-"));
    build(sourceDir);
    // -y stores a symlink as a link instead of following it.
    const result = spawnSync("zip", ["-q", "-r", "-y", join(archivesDir, name), ...members], {
      cwd: sourceDir,
    });
    expect(result.status).toBe(0);
  }

  test("extracts an ordinary pack", async () => {
    buildArchive(
      "honest.zip",
      (source) => {
        mkdirSync(join(source, "audio"));
        writeFileSync(join(source, "audio", "cue.ogg"), "sound");
      },
      ["audio"]
    );

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result).toEqual({ extracted: ["honest"], failed: [] });
    expect(readdirSync(join(extractedDir, "honest", "audio"))).toEqual(["cue.ogg"]);
  });

  test("refuses a pack whose symlink member points outside the extraction root", async () => {
    // The member name `link` is perfectly safe lexically; only the audit of
    // what unzip really wrote can see that it resolves to `outsideDir`.
    buildArchive("hostile.zip", (source) => symlinkSync(outsideDir, join(source, "link")), [
      "link",
    ]);

    const result = await extractArchives(archivesDir, extractedDir);

    expect(result).toEqual({ extracted: [], failed: ["hostile.zip"] });
    // Nothing from the hostile pack is left behind, staged or published.
    expect(readdirSync(extractedDir)).toEqual([]);
    expect(readdirSync(outsideDir)).toEqual(["secret.txt"]);
  });

  test("keeps a previous good extraction when a replacement archive is hostile", async () => {
    buildArchive("pack.zip", (source) => writeFileSync(join(source, "cue.ogg"), "first"), [
      "cue.ogg",
    ]);
    expect((await extractArchives(archivesDir, extractedDir)).extracted).toEqual(["pack"]);

    rmSync(join(archivesDir, "pack.zip"));
    buildArchive("pack.zip", (source) => symlinkSync(outsideDir, join(source, "cue.ogg")), [
      "cue.ogg",
    ]);

    const result = await extractArchives(archivesDir, extractedDir);
    expect(result.failed).toEqual(["pack.zip"]);
    expect(readFileSync(join(extractedDir, "pack", "cue.ogg"), "utf8")).toBe("first");
  });
});
