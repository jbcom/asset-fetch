# @jbcom/asset-fetch

[![npm](https://img.shields.io/npm/v/@jbcom/asset-fetch.svg)](https://www.npmjs.com/package/@jbcom/asset-fetch)
[![license](https://img.shields.io/npm/l/@jbcom/asset-fetch.svg)](./LICENSE)

CLI-first, multi-backend asset search + fetch toolkit: fetch the itch.io
library you already own, then promote a curated subset into a game project.

## Install

```bash
npm install @jbcom/asset-fetch     # library use
npx @jbcom/asset-fetch --help      # one-off CLI use
```

Requires Node.js >= 24. Ships ESM and CommonJS with types for both.

**Shipped today:** the itch.io backend — owned-library fetch and
curated-asset promotion.

**Planned:** a NAS-catalog backend and a Polyhaven backend (public
HDRI/texture/model API). See `ROADMAP.md`. This package is CLI +
library only — no MCP server.

## CLI

```bash
export ITCH_API_KEY=...   # or write ITCH_API_KEY=... to .env in cwd

asset-fetch library
# paginates itch.io's my-owned-keys endpoint into .itch-cache/library.json

asset-fetch search [query] [--bucket=audio|pixel-2d|3d-psx|tool|other]
# queries the cached owned library by text and/or content bucket

asset-fetch download allowlist.json [--dry]
# fetches + extracts allow-listed owned packs into raw-assets/
```

`allowlist.json` is a flat JSON array of exact pack titles, matched
against the cached library:

```json
["Casual Upbeat Game Music Pack – 10 Happy Loops", "UI Sound Effects Pack – 40 Game Interface Sounds (WAV + MP3)"]
```

Promotion (`raw-assets/` → `public/assets/`) is deliberately **not** a
CLI command — the slot→source mapping is game-specific. Import
`promoteAssets` and write a short per-repo script:

```ts
import { listExtractedAudioFiles, promoteAssets, writeAssetManifest } from "@jbcom/asset-fetch";

const files = listExtractedAudioFiles("raw-assets/extracted");
const { manifest } = promoteAssets({
  targetDir: "public/assets/audio",
  apply: true,
  normalize: true, // loudness-normalize via ffmpeg (-16 LUFS), if ffmpeg is on PATH
  slots: [
    { name: "ambient-pad", sources: files.filter((f) => f.includes("calm-loop")) },
    { name: "bark", sources: files.filter((f) => f.includes("thud")) },
  ],
});
writeAssetManifest("public/assets/audio", manifest);
```

## Library API

- `fetchOwnedLibrary({ apiKey, maxPages? })` — paginate `my-owned-keys`.
- `dedupeByGame(packs)` — one row per unique game (the same game can
  appear under multiple download keys — free + paid bundles, replacement
  keys).
- `classifyPack(pack)` — coarse bucket (`audio` / `pixel-2d` / `3d-psx` /
  `tool` / `other`) from title+description text.
- `searchLibrary(packs, { query?, bucket? })` — filter an already-fetched
  owned-library array by free-text query and/or content bucket. Local
  search over what you already own — itch.io has no documented public
  catalog-search API (see `ROADMAP.md`).
- `sanitizeItchUrl(url)` — strips malformed URLs some pack authors paste
  into the URL field itself (`bone-buster`'s fix, generalized).

## Fetch API

- `fetchItchAssets({ apiKey, packs, archivesDir, looseDir, dry? })` —
  downloads every upload for the given packs. TOCTOU-safe idempotency
  (reads the destination once, compares size+md5, rather than
  exists-then-read); every download is forced through https with
  `--proto`/`--proto-redir` pinning on the initial request AND every
  redirect hop; filenames are `basename()`-stripped so a malicious
  `upload.filename` can't zip-slip outside the target directory.
- `extractArchives(archivesDir, extractedDir)` — `.zip` via the system
  `unzip`, `.rar` via `node-unrar-js` (the only prior variant that
  handled non-zip archives, generalized here), `.7z` via the system `7z`
  if present. Skips archives already extracted at least as recently as
  their source archive's mtime.

## Promote API

- `listExtractedAudioFiles(dir)` — recursively lists `.wav`/`.mp3`/
  `.ogg`/`.flac` files under a directory.
- `promoteAssets({ slots, targetDir, apply?, normalize? })` — copies
  curated slot files into a game's public asset directory. Dry-run by
  default (`apply: false` reports what *would* be copied); idempotent
  (re-running overwrites the slot's files, never appends a growing
  pile).
- `writeAssetManifest(targetDir, manifest)` — writes `manifest.json`
  next to the promoted files, for the consuming game's own audio-loading
  code (e.g. `@jbcom/gesture-audio`'s Howler sprite resolver) to
  read rather than hardcoding filenames in game source.

## Security notes

- Never logs a signed download URL (it can carry a short-lived auth
  token — CWE-532).
- `ITCH_API_KEY` is read from `process.env` first, then a gitignored
  `.env` in the caller's cwd — never committed, never printed.
- All archive extraction targets are namespaced under the caller-chosen
  `extractedDir`; archive filenames are slugified before use as
  directory names.
