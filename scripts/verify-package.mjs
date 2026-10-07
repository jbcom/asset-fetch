import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toLowerCase().startsWith("npm_config_") &&
        !/auth|token|secret|password|credential/i.test(key)
    )
  ),
};
const scratch = mkdtempSync(path.join(tmpdir(), "asset-fetch-package-"));
const runNpm = (args, cwd) =>
  execFileSync(npm, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
try {
  const [pack] = JSON.parse(
    runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], root)
  );
  const files = new Set(pack.files.map(({ path: name }) => name));
  for (const required of [
    "package.json",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "docs/API.md",
    "docs/ARCHITECTURE.md",
    "docs/TROUBLESHOOTING.md",
    "docs/assets/favicon.svg",
    "examples/check.mjs",
    "examples/search-owned.mjs",
    "examples/promote-audio.mjs",
    "examples/commonjs.cjs",
    "llms.txt",
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
    "dist/cli.js",
  ])
    assert(files.has(required), `packed artifact is missing ${required}`);
  for (const prefix of ["src/", "tests/", "scripts/", ".github/", "coverage/", "node_modules/"]) {
    assert(
      [...files].every((file) => !file.startsWith(prefix)),
      `packed artifact contains ${prefix}`
    );
  }
  const consumer = path.join(scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "asset-fetch-consumer", private: true, type: "module" })
  );
  const userConfig = path.join(scratch, "anonymous.npmrc");
  const globalConfig = path.join(scratch, "empty-global.npmrc");
  writeFileSync(userConfig, "registry=https://registry.npmjs.org/\n");
  writeFileSync(globalConfig, "");
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      "https://registry.npmjs.org/",
      "--userconfig",
      userConfig,
      "--globalconfig",
      globalConfig,
      path.join(scratch, pack.filename),
    ],
    consumer
  );
  const exports = [
    "readItchApiKey",
    "resolveAssetsRoot",
    "searchCatalog",
    "extractArchives",
    "fetchItchAssets",
    "slugify",
    "classifyPack",
    "dedupeByGame",
    "fetchOwnedLibrary",
    "sanitizeItchUrl",
    "searchLibrary",
    "fetchPolyhavenAsset",
    "listPolyhavenFiles",
    "searchPolyhaven",
    "promoteAssets",
    "writeAssetManifest",
    "listExtractedAudioFiles",
    "assertExtractionContained",
    "assertWithin",
    "sanitizeKey",
    "findAssets",
  ];
  const exercise = `
    const assert = ${"ASSERT"};
    for (const name of ${JSON.stringify(exports)}) assert.equal(typeof api[name], 'function', name);
    assert(api.KEY_PATTERN instanceof RegExp);
    assert.equal(api.sanitizeKey('ambient-pad'), 'ambient-pad');
    assert.equal(api.sanitizeKey('../escape'), undefined);
    assert.equal(api.slugify('Forest Ambience'), 'forest-ambience');
    const packs = [{ keyId: 1, gameId: 2, title: 'Forest Ambience', classification: 'asset', shortText: 'Looping audio', url: 'https://example.itch.io/forest' }];
    assert.equal(api.searchLibrary(packs, { query: 'forest', bucket: 'audio' }).length, 1);
    assert.equal(metadata.name, 'asset-fetch');
    process.stdout.write(JSON.stringify(Object.keys(api).sort()));
  `;
  const draw = (type, source) =>
    execFileSync(process.execPath, [`--input-type=${type}`, "--eval", source], {
      cwd: consumer,
      env,
      encoding: "utf8",
    });
  const esm = draw(
    "module",
    `import * as api from 'asset-fetch'; import metadata from 'asset-fetch/package.json' with { type: 'json' }; import assertion from 'node:assert/strict'; ${exercise.replace("ASSERT", "assertion")}`
  );
  const cjs = draw(
    "commonjs",
    `const api = require('asset-fetch'); const metadata = require('asset-fetch/package.json'); ${exercise.replace("ASSERT", "require('node:assert/strict')")}`
  );
  assert.equal(esm, cjs, "installed ESM and CommonJS exports disagree");
  const help = execFileSync(
    path.join(
      consumer,
      "node_modules/.bin",
      process.platform === "win32" ? "asset-fetch.cmd" : "asset-fetch"
    ),
    ["--help"],
    { cwd: consumer, env, encoding: "utf8", shell: process.platform === "win32" }
  );
  assert.match(help, /asset-fetch/);
  console.log(
    `asset-fetch: ${pack.entryCount} packed files; installed ESM, CommonJS and CLI passed`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
