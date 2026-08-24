import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "cli.js");

// The CLI is the package's primary interface, so these run the built artifact
// rather than the sources — the shipped `bin` is what a consumer invokes.
// A fresh checkout has no dist/, and skipping on that basis would make these
// tests silently vanish in CI, so build it on demand instead.
beforeAll(() => {
  if (!existsSync(cli)) {
    execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit" });
  }
}, 120_000);

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      // Strip any real credential so the test asserts the no-key path.
      env: { ...process.env, ITCH_API_KEY: undefined } as NodeJS.ProcessEnv,
      cwd: root,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
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
});
