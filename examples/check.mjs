import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const examples = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "asset-fetch-examples-"));
const run = (file, args = []) =>
  execFileSync(process.execPath, [path.join(examples, file), ...args], {
    encoding: "utf8",
    cwd: scratch,
  });
try {
  assert.match(run("search-owned.mjs"), /Forest Ambience/);
  const source = path.join(scratch, "ambient.wav");
  const target = path.join(scratch, "audio");
  writeFileSync(source, "example audio fixture");
  run("promote-audio.mjs", [source, target]);
  assert.equal(existsSync(target), false, "dry-run wrote files");
  run("promote-audio.mjs", [source, target, "--apply"]);
  assert.equal(readFileSync(path.join(target, "ambient-pad.wav"), "utf8"), "example audio fixture");
  assert.match(run("commonjs.cjs"), /CommonJS:/);
  console.log("Examples: search, dry-run, promotion and CommonJS passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
