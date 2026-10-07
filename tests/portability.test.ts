import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TEXT = new Set([".ts", ".mjs", ".cjs", ".js", ".json", ".md", ".txt", ".yml", ".yaml"]);
const SKIP = new Set(["node_modules", "dist", "coverage", ".git"]);

// What ships must not name any particular machine: no mount points, home
// directories or catalog locations that only exist on the author's computer.
const MACHINE_SPECIFIC: Array<[string, RegExp]> = [
  ["a macOS volume mount", /\/Volumes\//],
  ["a macOS home directory", /\/Users\/[A-Za-z]/],
  ["a Linux home directory", /\/home\/[a-z]/],
  ["the previous catalog location", /\.local\/share\/assets-mcp/],
  ["a network-attached storage default", /\bNAS\b/],
];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (TEXT.has(extname(name)) && !path.endsWith("pnpm-lock.yaml")) yield path;
  }
}

describe("published files are machine-neutral", () => {
  const sources = [...files(root)].filter((path) => !path.endsWith("portability.test.ts"));

  test("finds the files it is meant to scan", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some((path) => path.endsWith(join("src", "catalog.ts")))).toBe(true);
  });

  test.each(MACHINE_SPECIFIC)("contains no reference to %s", (_label, pattern) => {
    const hits = sources
      .filter((path) => !path.endsWith("CHANGELOG.md"))
      .filter((path) => pattern.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length + 1));
    expect(hits).toEqual([]);
  });
});
