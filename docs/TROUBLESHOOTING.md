# Troubleshooting

## `ITCH_API_KEY missing`

Set `ITCH_API_KEY` in the environment or place it in a gitignored `.env` in the
working directory. The parser accepts `export ITCH_API_KEY=...`, quoted values,
and inline comments. The key is never printed.

## No itch.io results in `find`

Run `asset-fetch itch library` first. Unified search reads
`.itch-cache/library.json`; it does not contact itch.io merely to answer a
search.

## NAS backend is unavailable

The default catalog is `~/.local/share/assets-mcp/catalog.db` and the default
asset root is `/path/to/assets`. Override them with
`ASSET_FETCH_CATALOG_DB` and `ASSET_FETCH_ASSETS_ROOT`. Missing paths are
reported as warnings so remote work and CI can continue without the NAS.

## Archive extraction failed

- `.zip` requires `unzip` on `PATH`.
- `.7z` requires `7z` on `PATH`.
- `.rar` is handled by the bundled `node-unrar-js` dependency.

An extraction failure does not replace a prior successful extraction. Remove
or repair the source archive and rerun the command; the source marker makes the
operation idempotent.

## Audio normalization failed

`normalize: true` requires `ffmpeg` on `PATH`. Use `normalize: false` to copy
without re-encoding. Promotion is staged, so a failed conversion leaves the
existing promoted files intact.

## A download keeps repeating

Existing files are reused only when the upstream size and, when available, MD5
match. A repeatedly downloaded file is usually changing upstream or being
modified after download. The final destination is never replaced by a partial
transfer.

## Node warns that `node:sqlite` is experimental

Use the pinned Node 24 release from `.nvmrc`. The warning reflects Node's API
stability label; the catalog connection is read-only and covered by integration
tests on all supported CI operating systems.
