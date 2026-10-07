import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assertExtractionContained,
  assertWithin,
  KEY_PATTERN,
  sanitizeKey,
} from "../src/safety.js";

// Windows CI enables Developer Mode so real file and directory links are tested.
const symlinks = test;

let missingRootStat = false;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: string, options?: { throwIfNoEntry?: boolean }) => {
      if (missingRootStat && dirname(path) === path) return undefined;
      return actual.lstatSync(path, options);
    },
  };
});

let scratch: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "asset-fetch-safety-"));
  scratch.push(dir);
  return dir;
}

beforeEach(() => {
  missingRootStat = false;
  scratch = [];
});

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("assertWithin", () => {
  test("resolves a filesystem root even if its stat lookup reports missing", () => {
    missingRootStat = true;
    const root = resolve(sep);
    expect(assertWithin(root, [root])).toBe(root);
  });

  test("rejects an existing parent symlink that escapes the chosen root", () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, "linked"), "dir");
    expect(() => assertWithin(join(root, "linked", "new", "file"), [root])).toThrow(/outside/);
  });

  test("rejects a dangling destination ancestor", () => {
    const root = tmp();
    symlinkSync(join(root, "missing"), join(root, "linked"), "dir");
    expect(() => assertWithin(join(root, "linked", "file"), [root])).toThrow();
  });

  test("allows an existing parent symlink that stays inside the root", () => {
    const root = tmp();
    mkdirSync(join(root, "actual"));
    symlinkSync(join(root, "actual"), join(root, "linked"), "dir");
    expect(assertWithin(join(root, "linked", "new"), [root])).toBe(join(root, "linked", "new"));
  });

  test("accepts a path inside a root and returns it resolved", () => {
    const root = tmp();
    expect(assertWithin(join(root, "a", "b"), [root])).toBe(resolve(root, "a", "b"));
  });

  test("accepts the root itself and any one of several roots", () => {
    const first = tmp();
    const second = tmp();
    expect(assertWithin(first, [first])).toBe(resolve(first));
    expect(assertWithin(join(second, "x"), [first, second])).toBe(resolve(second, "x"));
  });

  test("resolves relative roots before comparing", () => {
    expect(assertWithin("relative-root/file.ogg", ["relative-root"])).toBe(
      resolve("relative-root", "file.ogg")
    );
  });

  test("refuses a traversal escape", () => {
    const root = tmp();
    expect(() => assertWithin(join(root, "..", "escaped"), [root])).toThrow(/outside/);
  });

  test("refuses an absolute path elsewhere", () => {
    const root = tmp();
    expect(() => assertWithin(resolve(sep, "elsewhere", "file"), [root])).toThrow(/outside/);
  });

  test("refuses everything when no root is given", () => {
    expect(() => assertWithin(tmp(), [])).toThrow(/outside/);
  });

  test("does not accept a sibling that merely shares a string prefix", () => {
    const root = tmp();
    expect(() => assertWithin(`${root}-evil${sep}x`, [root])).toThrow(/outside/);
  });

  test("accepts a child whose name merely starts with two dots", () => {
    const root = tmp();
    expect(assertWithin(join(root, "..hidden"), [root])).toBe(resolve(root, "..hidden"));
  });

  test("works when the root is the filesystem root", () => {
    const filesystemRoot = resolve(sep);
    expect(assertWithin(resolve(filesystemRoot, "anything"), [filesystemRoot])).toBe(
      resolve(filesystemRoot, "anything")
    );
  });
});

describe("assertExtractionContained", () => {
  test("passes a clean extraction", () => {
    const dir = tmp();
    mkdirSync(join(dir, "pack"));
    writeFileSync(join(dir, "pack", "sound.ogg"), "x");
    expect(() => assertExtractionContained(dir)).not.toThrow();
  });

  test("passes an empty extraction", () => {
    expect(() => assertExtractionContained(tmp())).not.toThrow();
  });

  symlinks("refuses a symlink that points outside the extraction directory", () => {
    const dir = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(dir, "link"));
    expect(() => assertExtractionContained(dir)).toThrow(/escapes extraction dir/);
  });

  symlinks("refuses a relative symlink that climbs out of a nested directory", () => {
    const dir = tmp();
    const outside = tmp();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    symlinkSync(relative(join(dir, "a", "b"), outside), join(dir, "a", "b", "up"), "dir");
    expect(() => assertExtractionContained(dir)).toThrow(/escapes extraction dir/);
  });

  symlinks("refuses a symlinked directory leading outside, without following it", () => {
    const dir = tmp();
    const outside = tmp();
    mkdirSync(join(outside, "deep"));
    writeFileSync(join(outside, "deep", "file"), "x");
    symlinkSync(outside, join(dir, "portal"), "dir");
    expect(() => assertExtractionContained(dir)).toThrow(/escapes extraction dir/);
  });

  symlinks("refuses a dangling symlink, because its target cannot be proven inside", () => {
    const dir = tmp();
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));
    expect(() => assertExtractionContained(dir)).toThrow(/cannot be resolved/);
  });

  symlinks("does not loop forever on a self-referential symlink inside the tree", () => {
    const dir = tmp();
    mkdirSync(join(dir, "sub"));
    symlinkSync(join(dir, "sub"), join(dir, "sub", "loop"), "dir");
    expect(() => assertExtractionContained(dir)).not.toThrow();
  });

  symlinks("allows a symlink that stays inside the extraction directory", () => {
    const dir = tmp();
    writeFileSync(join(dir, "real.ogg"), "x");
    symlinkSync(join(dir, "real.ogg"), join(dir, "alias.ogg"));
    expect(() => assertExtractionContained(dir)).not.toThrow();
  });

  symlinks("audits entries below an ordinary directory", () => {
    const dir = tmp();
    const outside = tmp();
    mkdirSync(join(dir, "pack", "nested"), { recursive: true });
    symlinkSync(outside, join(dir, "pack", "nested", "escape"), "dir");
    expect(() => assertExtractionContained(dir)).toThrow(/escapes extraction dir/);
  });
});

describe("sanitizeKey", () => {
  test("accepts a plausible key", () => {
    expect(sanitizeKey("abc123XYZ_-.def456")).toBe("abc123XYZ_-.def456");
  });

  test.each([
    "short",
    "has space",
    "has\nnewline",
    "has\rcarriage",
    "semi;colon",
    'quote"mark',
    "ITCH_API_KEY=nested",
    "Bearer abcdefghij",
    "a".repeat(129),
    "",
  ])("rejects a value that could poison a header (%j)", (bad) => {
    expect(sanitizeKey(bad)).toBeUndefined();
  });

  test("trims, because a .env line usually has trailing whitespace", () => {
    expect(sanitizeKey("  abcdefghij  ")).toBe("abcdefghij");
  });

  test.each([undefined, null, 12345678, {}, []])(
    "rejects a non-string (%j) rather than coercing it",
    (bad) => {
      expect(sanitizeKey(bad)).toBeUndefined();
    }
  );

  test("the pattern itself bounds the length at 8 to 128", () => {
    expect(KEY_PATTERN.test("a".repeat(7))).toBe(false);
    expect(KEY_PATTERN.test("a".repeat(8))).toBe(true);
    expect(KEY_PATTERN.test("a".repeat(128))).toBe(true);
    expect(KEY_PATTERN.test("a".repeat(129))).toBe(false);
  });
});
