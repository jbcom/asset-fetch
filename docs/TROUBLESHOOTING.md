---
title: Troubleshooting
description: Fixes for the environmental failures asset-fetch reports.
---

## `ITCH_API_KEY missing or malformed`

Set `ITCH_API_KEY` in the environment or place it in a gitignored `.env` in the working directory. The
parser accepts `export ITCH_API_KEY=...`, quoted values and inline comments. A key is 8 to 128
letters, digits, `.`, `_` or `-`; a value with a space, a newline or a `KEY=` prefix is rejected
rather than sent. The key is never printed.

## No itch.io results in `find`

Run `asset-fetch itch library` first. Unified search reads `.itch-cache/library.json`; it does not
contact itch.io merely to answer a search.

## `catalog: Asset root is not configured`

The local 3D catalog needs to know which directory it indexes, and there is no default because any
default would be a path that exists on only one machine. Set `ASSET_FETCH_ASSETS_ROOT`, or pass
`assetsRoot` in library code. Until then `find` reports the warning and still returns results from
the other sources.

## `catalog: Asset root is not mounted or does not exist`

The configured root is not present: an unmounted drive, a typo, or a CI job without the library. Work
that does not need the catalog continues; `find --source=catalog` returns no results and exits
non-zero.

## `catalog: Asset catalog does not exist`

The default catalog is `~/.local/share/game-asset-mcp/catalog.db`, where game-asset-mcp writes it. If
yours lives elsewhere, set `ASSET_FETCH_CATALOG_DB` (or pass `databasePath`). Build the catalog with
game-asset-mcp first; asset-fetch only reads it.

## Archive extraction failed

- `.zip` requires `unzip` on `PATH`.
- `.7z` requires `7z` on `PATH`.
- `.rar` is handled by the bundled `node-unrar-js` dependency.

An extraction failure does not replace a prior successful extraction. A pack is also reported as
failed when its extracted tree contains a symlink that points outside the extraction directory, or
one whose target cannot be resolved: that archive is rejected whole rather than partly accepted.
Remove or repair the source archive and rerun the command; the source marker makes the operation
idempotent.

## Audio normalization failed

`normalize: true` requires `ffmpeg` on `PATH`. Use `normalize: false` to copy without re-encoding.
Promotion is staged, so a failed conversion leaves the existing promoted files intact.

## A download keeps repeating

Existing files are reused only when the upstream size and, when available, MD5 match. A repeatedly
downloaded file is usually changing upstream or being modified after download. The final destination
is never replaced by a partial transfer.

## Node warns that `node:sqlite` is experimental

The warning reflects Node's API stability label for `node:sqlite`; the catalog connection is
read-only and covered by integration tests on every supported CI operating system.
