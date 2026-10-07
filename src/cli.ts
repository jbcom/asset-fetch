#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readItchApiKey } from "./apiKey.js";
import { extractArchives, fetchItchAssets } from "./fetch.js";
import {
  dedupeByGame,
  fetchOwnedLibrary,
  type LibraryBucket,
  type OwnedPack,
  searchLibrary,
} from "./library.js";
import { fetchPolyhavenAsset } from "./polyhaven.js";
import { type AssetKind, type AssetSource, findAssets } from "./search.js";

const [, , rawCommand, ...rawRest] = process.argv;
let command = rawCommand;
let rest = rawRest;
if (command === "itch") {
  [command, ...rest] = rest;
}
const cwd = process.cwd();
const dry = rest.includes("--dry");
const BUCKETS = new Set<LibraryBucket>(["audio", "pixel-2d", "3d-psx", "tool", "other"]);
const SOURCES = new Set<AssetSource>(["itch", "catalog", "polyhaven"]);
const KINDS = new Set<AssetKind>(["audio", "2d", "3d", "hdri", "texture", "tool", "other"]);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): string {
  return [
    "usage: asset-fetch <command>",
    "",
    "  find <query> [--source=itch|catalog|polyhaven|all] [--type=<kind>] [--limit=20] [--json]",
    "                              search available asset backends and merge results",
    "  polyhaven fetch <id> [--resolution=1k] [--format=gltf] [--output=<dir>]",
    "                              download and verify one Poly Haven asset variant",
    "  itch library                paginate profile/owned-keys into .itch-cache/library.json",
    "  itch search [query] [--bucket=audio|pixel-2d|3d-psx|tool|other]",
    "                              query the cached owned library by text and/or bucket",
    "  itch download <allow.json> [--dry]",
    "                              fetch + extract allow-listed owned packs into raw-assets/",
    "",
    "The legacy library/search/download command names remain aliases for itch subcommands.",
    "",
    "Promotion (raw-assets/ -> public/assets/) is intentionally NOT a CLI command —",
    "import { promoteAssets } from 'asset-fetch' and write a short",
    "per-repo script that defines the actual slot->source mapping for your game.",
    "",
    "Asset kinds: audio, 2d, 3d, hdri, texture, tool, other.",
  ].join("\n");
}

if (command === undefined || command === "--help" || command === "-h" || command === "help") {
  console.log(usage());
  process.exit(0);
}

// Only the commands that talk to itch.io need a credential. Requiring it up
// front made `--help` fail for an unrelated reason.
function requireApiKey(): string {
  const key = readItchApiKey(cwd);
  if (!key) {
    fail(
      "ITCH_API_KEY missing or malformed — set the env var or add `ITCH_API_KEY=<key>` to .env in the current directory. A key is 8 to 128 letters, digits, `.`, `_` or `-`."
    );
  }
  return key;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

function readLibraryCache(path: string): OwnedPack[] {
  const value = readJson(path, "library cache");
  if (!Array.isArray(value)) throw new Error("library cache must contain a JSON array");
  for (const [index, pack] of value.entries()) {
    if (
      typeof pack !== "object" ||
      pack === null ||
      typeof pack.keyId !== "number" ||
      typeof pack.gameId !== "number" ||
      typeof pack.title !== "string" ||
      typeof pack.classification !== "string" ||
      typeof pack.shortText !== "string" ||
      typeof pack.url !== "string"
    ) {
      throw new Error(`library cache entry ${index} is invalid; run \`asset-fetch library\` again`);
    }
  }
  return value as OwnedPack[];
}

function readAllowList(path: string): string[] {
  const value = readJson(path, "allow-list");
  if (!Array.isArray(value) || value.some((title) => typeof title !== "string" || !title.trim())) {
    throw new Error("allow-list must be a JSON array of non-empty pack titles");
  }
  return value;
}

async function main(): Promise<void> {
  switch (command) {
    case "find": {
      const knownFlags = ["--source=", "--type=", "--limit=", "--json"];
      const unknownFlag = rest.find(
        (arg) =>
          arg.startsWith("--") &&
          !knownFlags.some((known) => (known.endsWith("=") ? arg.startsWith(known) : arg === known))
      );
      if (unknownFlag) fail(`unknown find option: ${unknownFlag}`);
      const query = rest.find((arg) => !arg.startsWith("--"));
      if (!query) fail("usage: asset-fetch find <query> [--source=itch|catalog|polyhaven|all]");
      const sourceValue =
        rest.find((arg) => arg.startsWith("--source="))?.slice("--source=".length) ?? "all";
      if (sourceValue !== "all" && !SOURCES.has(sourceValue as AssetSource)) {
        fail(`invalid source: ${sourceValue}\nexpected one of: all, ${[...SOURCES].join(", ")}`);
      }
      const kindValue = rest.find((arg) => arg.startsWith("--type="))?.slice("--type=".length);
      if (kindValue && !KINDS.has(kindValue as AssetKind)) {
        fail(`invalid asset type: ${kindValue}\nexpected one of: ${[...KINDS].join(", ")}`);
      }
      const limitText = rest.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
      const maxResults = limitText === undefined ? 20 : Number(limitText);
      const sources = sourceValue === "all" ? [...SOURCES] : [sourceValue as AssetSource];
      const cachePath = join(cwd, ".itch-cache", "library.json");
      const itchLibrary =
        sources.includes("itch") && existsSync(cachePath) ? readLibraryCache(cachePath) : undefined;
      const result = await findAssets(query, {
        sources,
        kind: kindValue as AssetKind | undefined,
        maxResults,
        itchLibrary,
      });
      if (rest.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const asset of result.results) {
          const location = asset.path ?? asset.url ?? "";
          console.log(
            `${asset.name}  [${asset.source}/${asset.kind}]${location ? `  ${location}` : ""}`
          );
        }
        console.log(`\n${result.results.length} result(s)`);
        for (const warning of result.warnings) console.error(`warning: ${warning}`);
      }
      if (result.results.length === 0 && result.warnings.length > 0) process.exitCode = 1;
      break;
    }

    case "polyhaven": {
      const [subcommand, assetId, ...options] = rest;
      if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
        console.log(usage());
        break;
      }
      if (subcommand !== "fetch" || !assetId || assetId.startsWith("--")) {
        fail(
          "usage: asset-fetch polyhaven fetch <id> [--resolution=1k] [--format=gltf] [--output=<dir>]"
        );
      }
      const allowed = ["--resolution=", "--format=", "--output="];
      const unknown = options.find(
        (arg) => !arg.startsWith("--") || !allowed.some((prefix) => arg.startsWith(prefix))
      );
      if (unknown) fail(`unknown polyhaven fetch option: ${unknown}`);
      const value = (prefix: string): string | undefined =>
        options.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
      const result = await fetchPolyhavenAsset({
        assetId,
        targetDir: resolve(value("--output=") ?? join(cwd, "raw-assets", "polyhaven")),
        resolution: value("--resolution="),
        format: value("--format="),
      });
      console.log(
        `polyhaven: downloaded=${result.downloaded.length} skipped=${result.skipped.length} -> ${result.directory}`
      );
      break;
    }

    case "library": {
      const cacheDir = join(cwd, ".itch-cache");
      const cachePath = join(cacheDir, "library.json");
      const packs = await fetchOwnedLibrary({ apiKey: requireApiKey() });
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify(packs, null, 2)}\n`);
      const unique = dedupeByGame(packs);
      console.log(
        `library: ${packs.length} owned keys, ${unique.length} unique games -> ${cachePath}`
      );
      break;
    }

    case "search": {
      const cachePath = join(cwd, ".itch-cache", "library.json");
      if (!existsSync(cachePath)) {
        fail(`No library cache at ${cachePath}. Run \`asset-fetch library\` first.`);
      }
      const unknownFlags = rest.filter(
        (arg) => arg.startsWith("--") && !arg.startsWith("--bucket=")
      );
      if (unknownFlags.length > 0) fail(`unknown search option: ${unknownFlags[0]}`);
      const library = readLibraryCache(cachePath);
      const bucketValue = rest.find((a) => a.startsWith("--bucket="))?.slice("--bucket=".length);
      if (bucketValue && !BUCKETS.has(bucketValue as LibraryBucket)) {
        fail(`invalid bucket: ${bucketValue}\nexpected one of: ${[...BUCKETS].join(", ")}`);
      }
      const bucketArg = bucketValue as LibraryBucket | undefined;
      const query = rest.find((a) => !a.startsWith("--"));
      const results = searchLibrary(library, { query, bucket: bucketArg });
      for (const pack of results) {
        console.log(`${pack.title}  [${pack.classification}]`);
      }
      console.log(`\n${results.length}/${library.length} owned keys matched`);
      break;
    }

    case "download": {
      const unknownFlags = rest.filter((arg) => arg.startsWith("--") && arg !== "--dry");
      if (unknownFlags.length > 0) fail(`unknown download option: ${unknownFlags[0]}`);
      const allowlistPath = rest.find((a) => !a.startsWith("--"));
      if (!allowlistPath) fail("usage: asset-fetch download <allowlist.json> [--dry]");
      const cachePath = join(cwd, ".itch-cache", "library.json");
      if (!existsSync(cachePath)) {
        fail(`No library cache at ${cachePath}. Run \`asset-fetch library\` first.`);
      }
      const library = readLibraryCache(cachePath);
      const allowList = new Set(readAllowList(resolve(allowlistPath)));
      const packs = dedupeByGame(library).filter((p) => allowList.has(p.title));
      const missing = [...allowList].filter((t) => !packs.some((p) => p.title === t));
      if (missing.length > 0) {
        fail(`allow-list titles missing from library cache:\n  ${missing.join("\n  ")}`);
      }

      const archivesDir = join(cwd, "raw-assets", "archives");
      const looseDir = join(cwd, "raw-assets", "extracted-loose");
      const extractedDir = join(cwd, "raw-assets", "extracted");

      const result = await fetchItchAssets({
        apiKey: requireApiKey(),
        packs,
        archivesDir,
        looseDir,
        dry,
      });
      console.log(
        `fetch: downloaded=${result.downloaded} skipped=${result.skipped} failed=${result.failed}`
      );
      if (!dry) {
        const extraction = await extractArchives(archivesDir, extractedDir);
        console.log(
          `extract: ${extraction.extracted.length} ok, ${extraction.failed.length} failed`
        );
        if (result.failed > 0 || extraction.failed.length > 0) process.exitCode = 1;
      } else if (result.failed > 0) {
        process.exitCode = 1;
      }
      break;
    }

    default:
      fail(`unknown command: ${command}\n\n${usage()}`);
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`asset-fetch: ${message}`);
  process.exitCode = 1;
});
