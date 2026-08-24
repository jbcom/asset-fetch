#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readItchApiKey } from "./apiKey.js";
import {
  dedupeByGame,
  fetchOwnedLibrary,
  type LibraryBucket,
  type OwnedPack,
  searchLibrary,
} from "./library.js";
import { extractArchives, fetchItchAssets } from "./fetch.js";

const [, , command, ...rest] = process.argv;
const cwd = process.cwd();
const dry = rest.includes("--dry");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): string {
  return [
    "usage: asset-fetch <command>",
    "",
    "  library                     paginate my-owned-keys into .itch-cache/library.json",
    "  search [query] [--bucket=audio|pixel-2d|3d-psx|tool|other]",
    "                              query the cached owned library by text and/or bucket",
    "  download <allow.json> [--dry]",
    "                              fetch + extract allow-listed owned packs into raw-assets/",
    "",
    "Promotion (raw-assets/ -> public/assets/) is intentionally NOT a CLI command —",
    "import { promoteAssets } from '@jbcom/asset-fetch' and write a short",
    "per-repo script that defines the actual slot->source mapping for your game.",
    "",
    "Other backends (NAS catalog, Polyhaven) are planned — see ROADMAP.md.",
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
      "ITCH_API_KEY missing — set the env var or add `ITCH_API_KEY=<key>` to .env in the current directory."
    );
  }
  return key;
}

switch (command) {
  case "library": {
    const cacheDir = join(cwd, ".itch-cache");
    const cachePath = join(cacheDir, "library.json");
    const packs = await fetchOwnedLibrary({ apiKey: requireApiKey() });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(packs, null, 2)}\n`);
    const unique = dedupeByGame(packs);
    console.log(`library: ${packs.length} owned keys, ${unique.length} unique games -> ${cachePath}`);
    break;
  }

  case "search": {
    const cachePath = join(cwd, ".itch-cache", "library.json");
    if (!existsSync(cachePath)) {
      fail(`No library cache at ${cachePath}. Run \`asset-fetch library\` first.`);
    }
    const library: OwnedPack[] = JSON.parse(readFileSync(cachePath, "utf8"));
    const bucketArg = rest.find((a) => a.startsWith("--bucket="))?.slice("--bucket=".length) as
      | LibraryBucket
      | undefined;
    const query = rest.find((a) => !a.startsWith("--"));
    const results = searchLibrary(library, { query, bucket: bucketArg });
    for (const pack of results) {
      console.log(`${pack.title}  [${pack.classification}]`);
    }
    console.log(`\n${results.length}/${library.length} owned keys matched`);
    break;
  }

  case "download": {
    const allowlistPath = rest.find((a) => !a.startsWith("--"));
    if (!allowlistPath) fail("usage: asset-fetch download <allowlist.json> [--dry]");
    const cachePath = join(cwd, ".itch-cache", "library.json");
    if (!existsSync(cachePath)) {
      fail(`No library cache at ${cachePath}. Run \`asset-fetch library\` first.`);
    }
    const library: Array<{ gameId: number; keyId: number; title: string }> = JSON.parse(
      readFileSync(cachePath, "utf8")
    );
    const allowList = new Set<string>(JSON.parse(readFileSync(resolve(allowlistPath), "utf8")));
    const packs = library.filter((p) => allowList.has(p.title));
    const missing = [...allowList].filter((t) => !packs.some((p) => p.title === t));
    if (missing.length > 0) {
      fail(`allow-list titles missing from library cache:\n  ${missing.join("\n  ")}`);
    }

    const archivesDir = join(cwd, "raw-assets", "archives");
    const looseDir = join(cwd, "raw-assets", "extracted-loose");
    const extractedDir = join(cwd, "raw-assets", "extracted");

    const result = await fetchItchAssets({ apiKey: requireApiKey(), packs, archivesDir, looseDir, dry });
    console.log(
      `fetch: downloaded=${result.downloaded} skipped=${result.skipped} failed=${result.failed}`
    );
    if (!dry) {
      const extraction = await extractArchives(archivesDir, extractedDir);
      console.log(
        `extract: ${extraction.extracted.length} ok, ${extraction.failed.length} failed`
      );
    }
    break;
  }

  default:
    fail(`unknown command: ${command}\n\n${usage()}`);
}
