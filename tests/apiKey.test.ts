import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readItchApiKey } from "../src/apiKey.js";

describe("readItchApiKey", () => {
  let dir: string;
  const originalEnv = process.env.ITCH_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "itch-apikey-test-"));
    delete process.env.ITCH_API_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.ITCH_API_KEY;
    } else {
      process.env.ITCH_API_KEY = originalEnv;
    }
  });

  test("prefers process.env over a .env file", () => {
    process.env.ITCH_API_KEY = "from-env-var";
    writeFileSync(join(dir, ".env"), "ITCH_API_KEY=from-dot-env\n");
    expect(readItchApiKey(dir)).toBe("from-env-var");
  });

  test("falls back to a .env file in the given root when env var is unset", () => {
    writeFileSync(join(dir, ".env"), "ITCH_API_KEY=from-dot-env\n");
    expect(readItchApiKey(dir)).toBe("from-dot-env");
  });

  test("finds the key among other lines in .env", () => {
    writeFileSync(join(dir, ".env"), "SOME_OTHER_VAR=1\nITCH_API_KEY=middle-key\nANOTHER=2\n");
    expect(readItchApiKey(dir)).toBe("middle-key");
  });

  test("handles .env files using CRLF line endings", () => {
    writeFileSync(join(dir, ".env"), "ITCH_API_KEY=crlf-key\r\nOTHER=1\r\n");
    expect(readItchApiKey(dir)).toBe("crlf-key");
  });

  test("accepts export syntax, whitespace, quotes, and inline comments", () => {
    writeFileSync(join(dir, ".env"), "  export ITCH_API_KEY = 'quoted-key'  \n");
    expect(readItchApiKey(dir)).toBe("quoted-key");

    writeFileSync(join(dir, ".env"), "ITCH_API_KEY=plain-key # local credential\n");
    expect(readItchApiKey(dir)).toBe("plain-key");

    writeFileSync(join(dir, ".env"), 'ITCH_API_KEY="double-quoted-key"\n');
    expect(readItchApiKey(dir)).toBe("double-quoted-key");
  });

  test("ignores blank environment and file values", () => {
    process.env.ITCH_API_KEY = "   ";
    writeFileSync(join(dir, ".env"), "ITCH_API_KEY=   \n");
    expect(readItchApiKey(dir)).toBeUndefined();
  });

  test("returns undefined when no .env file exists", () => {
    expect(readItchApiKey(dir)).toBeUndefined();
  });

  test("returns undefined when .env exists but has no ITCH_API_KEY line", () => {
    writeFileSync(join(dir, ".env"), "SOME_OTHER_VAR=1\n");
    expect(readItchApiKey(dir)).toBeUndefined();
  });
});
