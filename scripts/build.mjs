#!/usr/bin/env node
// Minimal build: tsc emits ESM + .d.ts, esbuild transpiles the same sources to CJS.
// No bundler — each source module maps 1:1 to a dist module.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}

execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    path.join(root, "tsconfig.build.json"),
  ],
  {
    cwd: root,
    stdio: "inherit",
  }
);

const entryPoints = readdirSync(srcDir)
  .filter((file) => /\.ts$/.test(file) && !file.endsWith(".test.ts") && file !== "cli.ts")
  .map((file) => path.join(srcDir, file));

await esbuild.build({
  entryPoints,
  outdir: distDir,
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  platform: "node",
  target: "es2022",
  bundle: false,
  sourcemap: false,
  logLevel: "info",
});

// tsc emits a single set of ESM `.d.ts` files. Under the "require" condition
// TypeScript reads those as ESM, so a CJS consumer sees types that claim to be
// ESM while the JavaScript beside them is CJS — attw reports this as
// "Masquerading as ESM" and publint warns about it. Mirror each declaration to
// `.d.cts`, rewriting relative specifiers to `.cjs` so they resolve to the CJS
// files rather than back to the ESM ones.
const declarations = readdirSync(distDir).filter((file) => file.endsWith(".d.ts"));
for (const file of declarations) {
  const source = readFileSync(path.join(distDir, file), "utf8");
  const rewritten = source.replace(/(from\s+"\.\/[^"]+)\.js"/g, '$1.cjs"');
  const target = file.replace(/\.d\.ts$/, ".d.cts");
  writeFileSync(path.join(distDir, target), rewritten);
}

console.log(
  `Built ${entryPoints.length} entry point(s) -> dist/ (ESM+d.ts via tsc, CJS+d.cts via esbuild)`
);
