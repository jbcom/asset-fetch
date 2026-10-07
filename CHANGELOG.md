# Changelog

## [0.2.1](https://github.com/jbcom/asset-fetch/compare/v0.2.0...v0.2.1) (2026-10-07)


### Bug Fixes

* support every maintained Node line (22, 24 and 26) ([8a6173b](https://github.com/jbcom/asset-fetch/commit/8a6173ba896e600c061f864b481a2620239ffdb1))
* support maintained Node lines and align repository gates ([2b47f13](https://github.com/jbcom/asset-fetch/commit/2b47f13a9595f0f2c10032bb2681de4fd64a491a))

## 0.2.0 (2026-10-07)

First release on npmjs, under the name `asset-fetch`, as open source under the MIT licence.

### Features

* unified search across an owned itch.io library, a local SQLite 3D catalog and Poly Haven
* verified Poly Haven model, texture and HDRI downloads
* atomic, integrity-checked itch.io downloads and staged archive extraction
* safe, idempotent audio promotion with optional ffmpeg normalization
* audit every extraction for entries and symlinks that escape its directory, and check every write
  destination with `assertWithin`
* gate API keys with `sanitizeKey` before they reach an `Authorization` header
* export `assertWithin`, `assertExtractionContained`, `sanitizeKey` and `KEY_PATTERN`
* ship a CommonJS build alongside ESM, each with its own declarations

### Changes

* the asset root for the local catalog is required (option or `ASSET_FETCH_ASSETS_ROOT`); there is no
  machine-specific default
* the catalog default path is the one game-asset-mcp writes, `~/.local/share/game-asset-mcp/catalog.db`
* the `nas` source and `searchNasCatalog` are now `catalog` and `searchCatalog`
* move to TypeScript 7, Vitest 5, Node 24 as the floor and Node 26 as the build toolchain
