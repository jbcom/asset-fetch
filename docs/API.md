---
title: API reference
description: Every export of asset-fetch, grouped by what it does, with the behavior callers rely on.
---

Everything is exported from the package root. `import { findAssets } from "asset-fetch"` works in
ESM and `const { findAssets } = require("asset-fetch")` in CommonJS, each with matching declarations.

## Discovery

### `findAssets(query, options?)`

```ts
findAssets(query: string, options?: FindAssetsOptions): Promise<FindAssetsResult>
```

Fans one query out across the selected sources and merges the results, ranked by how well the name
matches and otherwise in stable source order.

| Option | Meaning |
| --- | --- |
| `sources` | Any of `"itch"`, `"catalog"`, `"polyhaven"`. Defaults to all three. Duplicates throw. |
| `kind` | Restrict to `"audio"`, `"2d"`, `"3d"`, `"hdri"`, `"texture"`, `"tool"` or `"other"`. |
| `maxResults` | 1 to 100, default 20. |
| `itchLibrary` | The owned-pack array (from `fetchOwnedLibrary`). The `"itch"` source warns without it. |
| `catalog` | `SearchCatalogOptions` for the local 3D catalog. |
| `polyhaven` | `SearchPolyhavenOptions`, including an injectable `fetchImpl`. |

It returns `{ results, warnings }`. A source that is not configured or not reachable adds a warning
such as `catalog: Asset root is not configured: ...` and the other sources still contribute.
Invalid options (a bad limit, duplicate sources) throw.

Each `UnifiedAssetResult` has `source`, `id`, `name`, `description`, `kind`, and optionally `url`,
`path` and `previewUrl`.

## Owned itch.io library

| Function | Purpose |
| --- | --- |
| `fetchOwnedLibrary({ apiKey, maxPages?, fetchImpl?, sleepImpl? })` | Paginates the owned-keys endpoint into `OwnedPack[]`, retrying on HTTP 429 with `Retry-After` or exponential backoff. |
| `dedupeByGame(packs)` | One row per game, keeping the first key seen. |
| `classifyPack(pack)` | Content bucket: `audio`, `pixel-2d`, `3d-psx`, `tool` or `other`, inferred from title and description. |
| `searchLibrary(packs, { query?, bucket? })` | Filters an already-fetched library locally. |
| `sanitizeItchUrl(url)` | Returns the URL if it is plain `http(s)`, otherwise an empty string. |
| `readItchApiKey(root)` | `ITCH_API_KEY` from the environment, else `<root>/.env`; shape-checked; `undefined` when missing or malformed. |

The `.env` reader accepts an `export` prefix, CRLF line endings, single or double quotes, and a
trailing `# comment`.

## Downloading and extracting itch.io packs

### `fetchItchAssets(options)`

Downloads the selected packs' archives into `archivesDir` (loose audio into `looseDir` when a pack
has no archive). Each download lands in a private temporary directory, is verified against the
upload's size and MD5, and is then renamed into place, so a failed request never replaces a good
file. An existing file that already matches is skipped. With `dry: true` nothing is written.

It returns `{ downloaded, skipped, failed, archives }`. Remote filenames are reduced to a basename,
and each destination is checked with `assertWithin` before anything is written.

### `extractArchives(archivesDir, extractedDir)`

Extracts every `.zip`, `.rar` and `.7z` into `extractedDir/<slug>`, using the system `unzip`, the
bundled `node-unrar-js`, and the system `7z`. Entry names are checked before extraction; the
extracted tree is then audited with `assertExtractionContained` before it is moved into place. It
returns `{ extracted, failed }`, never throws for one bad archive, and never replaces an earlier good
extraction with a failed one.

## Local 3D catalog

### `searchCatalog(query?, options?)`

Queries the read-only SQLite catalog written by game-asset-mcp, using full-text search plus optional
`style`, `category`, `hasArmature` and `hasTextures` filters.

| Option | Default |
| --- | --- |
| `assetsRoot` | `ASSET_FETCH_ASSETS_ROOT`. **Required**: there is no default. |
| `databasePath` | `ASSET_FETCH_CATALOG_DB`, then `CATALOG_DB`, then `~/.local/share/game-asset-mcp/catalog.db`. |
| `maxResults` | 20 (1 to 100). |

The result is `{ available: true, assets, databasePath }`, or
`{ available: false, unavailableReason, message, assets: [], databasePath }` with the reason
`assets-root-missing`, `catalog-missing` or `catalog-error`. A missing mount or catalog is a normal
state and does not throw. An unconfigured asset root, and an invalid `maxResults`, do.

### `resolveAssetsRoot(explicit?)`

Returns the absolute asset root from the argument or `ASSET_FETCH_ASSETS_ROOT`, and throws a message
naming both when neither is set. A blank value counts as unset.

## Poly Haven

| Function | Purpose |
| --- | --- |
| `searchPolyhaven(query, { type?, maxResults?, fetchImpl? })` | Ranks public metadata for `hdris`, `textures` or `models`. |
| `listPolyhavenFiles(assetId, { fetchImpl? })` | Flattens the files response into `PolyhavenFile` descriptors (`key`, `relativePath`, `url`, `size`, `md5`). |
| `fetchPolyhavenAsset({ assetId, targetDir, resolution?, format?, fetchImpl?, downloadImpl? })` | Downloads one variant and its include files, verified, into `targetDir/<assetId>/`. Returns `{ directory, downloaded, skipped }`. |

Only HTTPS URLs on Poly Haven's download hosts are accepted, and redirects are pinned to the same
allowlist. Resolution, format and asset id are validated before any request is made.

## Promotion

| Function | Purpose |
| --- | --- |
| `promoteAssets({ slots, targetDir, apply?, normalize? })` | Plans, and with `apply: true` performs, a copy of slot sources into `targetDir`. Dry run by default. |
| `writeAssetManifest(targetDir, manifest)` | Atomically writes `manifest.json` as `{ generatedAt, slots }`. |
| `listExtractedAudioFiles(dir)` | Every `.wav`, `.mp3`, `.ogg` and `.flac` below `dir`, sorted. |

Slot names, duplicate sources, extensions and destination collisions are validated before any file is
touched. `normalize: true` runs `ffmpeg` loudness normalization and silently keeps the plain copy if
`ffmpeg` is unavailable.

## Safety primitives

| Export | Behavior |
| --- | --- |
| `assertWithin(candidate, roots)` | Resolves `candidate` and returns it if it is inside any root; otherwise throws `refusing path outside the asset tree`. Segment-aware. |
| `assertExtractionContained(dir)` | Throws `archive entry escapes extraction dir` for the first entry whose real path is outside `dir`, and `archive entry cannot be resolved` for a symlink with no resolvable target. Never follows a symlink. |
| `sanitizeKey(value)` | The trimmed key if it matches `KEY_PATTERN`; otherwise `undefined`. Never throws. |
| `KEY_PATTERN` | `/^[A-Za-z0-9._-]{8,128}$/`. |
