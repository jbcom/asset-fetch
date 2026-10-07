import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "cli.js");

// The CLI is the package's primary interface, so these run the built artifact
// rather than the sources — the shipped `bin` is what a consumer invokes.
// Always rebuild: an existing dist/ can be stale after a source edit, and the
// purpose of these tests is to execute the exact artifact the package ships.
beforeAll(() => {
  execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
}, 120_000);

function run(args: string[], cwd = root): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    // Strip any real credential so the test asserts the no-key path.
    env: { ...process.env, ITCH_API_KEY: undefined } as NodeJS.ProcessEnv,
    cwd,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe("cli usage", () => {
  // Regression: the credential check used to run before the command switch,
  // so `--help` failed with "ITCH_API_KEY missing" — the first thing a new
  // user runs, failing for an unrelated reason.
  test.each(["--help", "-h", "help"])("%s prints usage without a credential", (flag) => {
    const { status, stdout } = run([flag]);
    expect(status).toBe(0);
    expect(stdout).toContain("usage: asset-fetch <command>");
    expect(stdout).not.toContain("ITCH_API_KEY missing");
  });

  test("a bare invocation prints usage and exits cleanly", () => {
    const { status, stdout } = run([]);
    expect(status).toBe(0);
    expect(stdout).toContain("usage: asset-fetch <command>");
  });

  test("an unknown command reports it and shows usage", () => {
    const { status, stderr } = run(["bogus"]);
    expect(status).toBe(1);
    expect(stderr).toContain("unknown command: bogus");
    expect(stderr).toContain("usage: asset-fetch <command>");
  });

  // The credential gate must still protect the commands that reach itch.io.
  test("library still requires a credential", () => {
    const { status, stderr } = run(["library"]);
    expect(status).toBe(1);
    expect(stderr).toContain("ITCH_API_KEY missing");
  });

  test("download validates its arguments before doing any work", () => {
    // Argument and cache checks run ahead of the credential, so a bare
    // download reports usage rather than a missing key.
    const { status, stderr } = run(["download"]);
    expect(status).toBe(1);
    expect(stderr).toContain("usage: asset-fetch download");
  });

  test("search validates its cache, bucket, and unknown options", () => {
    const dir = mkdtempSync(join(tmpdir(), "asset-fetch-cli-search-"));
    try {
      mkdirSync(join(dir, ".itch-cache"), { recursive: true });
      writeFileSync(join(dir, ".itch-cache", "library.json"), "not json");
      expect(run(["search"], dir)).toMatchObject({ status: 1 });
      expect(run(["search"], dir).stderr).toContain("library cache is not valid JSON");

      writeFileSync(
        join(dir, ".itch-cache", "library.json"),
        `${JSON.stringify([
          {
            keyId: 1,
            gameId: 2,
            title: "UI Sounds",
            classification: "asset",
            shortText: "crisp audio",
            url: "",
          },
        ])}\n`
      );
      expect(run(["search", "sounds"], dir)).toMatchObject({ status: 0 });
      expect(run(["search", "--bucket=nope"], dir).stderr).toContain("invalid bucket");
      expect(run(["search", "--wat"], dir).stderr).toContain("unknown search option");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download rejects malformed caches, allow-lists, and unknown options before credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "asset-fetch-cli-download-"));
    try {
      mkdirSync(join(dir, ".itch-cache"), { recursive: true });
      writeFileSync(join(dir, ".itch-cache", "library.json"), "[]\n");
      writeFileSync(join(dir, "allow.json"), "{}\n");
      expect(run(["download", "allow.json"], dir).stderr).toContain(
        "allow-list must be a JSON array"
      );
      expect(run(["download", "allow.json", "--wat"], dir).stderr).toContain(
        "unknown download option"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("find searches the local itch cache and emits machine-readable JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "asset-fetch-cli-find-"));
    try {
      mkdirSync(join(dir, ".itch-cache"), { recursive: true });
      writeFileSync(
        join(dir, ".itch-cache", "library.json"),
        `${JSON.stringify([
          {
            keyId: 1,
            gameId: 2,
            title: "Forest Sounds",
            classification: "asset",
            shortText: "ambient audio",
            url: "https://author.itch.io/forest",
          },
        ])}\n`
      );
      const result = run(["find", "forest", "--source=itch", "--type=audio", "--json"], dir);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        results: [{ source: "itch", name: "Forest Sounds", kind: "audio" }],
        warnings: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("find and polyhaven commands reject invalid usage without network access", () => {
    expect(run(["find"]).stderr).toContain("usage: asset-fetch find");
    expect(run(["find", "tree", "--source=nope"]).stderr).toContain("invalid source");
    expect(run(["find", "tree", "--type=nope"]).stderr).toContain("invalid asset type");
    expect(run(["find", "tree", "--source=itch", "--limit=0"]).stderr).toContain(
      "maxResults must be"
    );
    expect(run(["find", "tree", "--wat"]).stderr).toContain("unknown find option");
    expect(run(["polyhaven", "fetch"]).stderr).toContain("usage: asset-fetch polyhaven fetch");
    expect(run(["polyhaven", "fetch", "asset", "--wat"]).stderr).toContain(
      "unknown polyhaven fetch option"
    );
    expect(run(["polyhaven", "--help"]).status).toBe(0);
    expect(run(["itch", "--help"]).status).toBe(0);
  });
});

describe("published examples", () => {
  test("owned-library search example runs against the built package", () => {
    const result = spawnSync(process.execPath, [join(root, "examples", "search-owned.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Forest Ambience");
  });

  test("promotion example applies a real plan and writes its manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "asset-fetch-example-"));
    try {
      const source = join(dir, "source.wav");
      const target = join(dir, "promoted");
      writeFileSync(source, "synthetic wave fixture");
      const result = spawnSync(
        process.execPath,
        [join(root, "examples", "promote-audio.mjs"), source, target, "--apply"],
        { cwd: root, encoding: "utf8" }
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"))).toEqual({
        generatedAt: expect.any(String),
        slots: [{ slot: "ambient-pad", files: ["ambient-pad.wav"], sourceCount: 1 }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
