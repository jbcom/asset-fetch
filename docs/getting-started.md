---
title: Getting started
description: Install asset-fetch, search for assets and fetch your first owned pack.
---

## Install

```sh
npm install asset-fetch
# or: pnpm add asset-fetch
```

Use Node.js 24 or newer. asset-fetch ships native ESM and CommonJS entry points with format-correct
TypeScript declarations, and the `asset-fetch` command.

## Search

```sh
npx asset-fetch find "pine tree" --type=3d
npx asset-fetch find "studio lighting" --source=polyhaven --type=hdri --json
```

Poly Haven needs no setup. To include a local 3D catalog, say where it lives:

```sh
export ASSET_FETCH_ASSETS_ROOT=/path/to/your/3d-assets
npx asset-fetch find knight --source=catalog
```

The catalog is read from `~/.local/share/game-asset-mcp/catalog.db` unless
`ASSET_FETCH_CATALOG_DB` says otherwise. Without an asset root the catalog is skipped with a warning.

## Fetch a Poly Haven asset

```sh
npx asset-fetch polyhaven fetch ceramic_vase_03 --resolution=1k --format=gltf
```

The model and its textures land in `raw-assets/polyhaven/ceramic_vase_03/`.

## Fetch packs you own on itch.io

```sh
export ITCH_API_KEY=your-key
npx asset-fetch itch library
npx asset-fetch itch search music --bucket=audio
echo '["Forest Ambience"]' > allowlist.json
npx asset-fetch itch download allowlist.json --dry
npx asset-fetch itch download allowlist.json
```

Archives are downloaded to `raw-assets/archives/` and extracted, after an audit, to
`raw-assets/extracted/`.

## Promote a selection into a project

```ts
import { listExtractedAudioFiles, promoteAssets, writeAssetManifest } from "asset-fetch";

const files = listExtractedAudioFiles("raw-assets/extracted");
const result = promoteAssets({
  targetDir: "public/assets/audio",
  apply: true,
  slots: [{ name: "ambient-pad", sources: files.filter((file) => file.includes("calm")) }],
});
writeAssetManifest("public/assets/audio", result.manifest);
```

Promotion is a dry run until `apply: true`.
