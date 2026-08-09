# @arcade-cabinet/assets-search

CLI-first, multi-backend asset search + fetch toolkit for the fleet.

**Shipped today:** the itch.io backend — owned-library fetch +
curated-asset promotion, extracted from the near-identical
`scripts/itch-library.mjs` + `scripts/fetch-itch-assets.mjs` +
`scripts/promote-audio.mjs` copies duplicated across 11+
arcade-cabinet fleet repos, one hardened implementation instead of a
dozen drifting forks.

**Planned:** a NAS-catalog backend (read-only query against
`assets-mcp`'s SQLite DB) and a Polyhaven backend (public
HDRI/texture/model API). See `ROADMAP.md`. This package is CLI +
library only — no MCP server; `assets-mcp` (a separate Python
project) stays the interactive NAS-cataloging tool.

## CLI

```bash
export ITCH_API_KEY=...   # or write ITCH_API_KEY=... to .env in cwd

assets-search library
# paginates itch.io's my-owned-keys endpoint into .itch-cache/library.json

assets-search search [query] [--bucket=audio|pixel-2d|3d-psx|tool|other]
# queries the cached owned library by text and/or content bucket

assets-search download allowlist.json [--dry]
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
import { listExtractedAudioFiles, promoteAssets, writeAssetManifest } from "@arcade-cabinet/assets-search";

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
  `unzip`, `.rar` via `node-unrar-js` (the only prior fleet variant that
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
  code (e.g. `@arcade-cabinet/audio-engine`'s Howler sprite resolver) to
  read rather than hardcoding filenames in game source.

## Security notes

- Never logs a signed download URL (it can carry a short-lived auth
  token — CWE-532).
- `ITCH_API_KEY` is read from `process.env` first, then a gitignored
  `.env` in the caller's cwd — never committed, never printed.
- All archive extraction targets are namespaced under the caller-chosen
  `extractedDir`; archive filenames are slugified before use as
  directory names.
