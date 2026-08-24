# asset-fetch

![An archive parcel passing through a verification gate and emerging as curated game assets](./docs/assets/asset-fetch-hero.webp)

[![license: MIT](https://img.shields.io/badge/license-MIT-17324d.svg)](./LICENSE)
[![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-5b8c3a.svg)](./.nvmrc)

Find game assets across the sources you actually use, fetch them defensively,
and promote a deliberate subset into a project. `asset-fetch` is a typed Node.js
library and CLI—not an MCP server—built for local scripts and CI.

It unifies three different workflows without pretending they have the same
trust or availability model:

- your owned itch.io library, including signed archive downloads;
- a read-only local SQLite catalog produced by assets-mcp; and
- public Poly Haven models, textures, and HDRIs.

Downloads are streamed into private temporary locations, verified by size and
upstream MD5 when available, then atomically moved into place. Archive
extraction and project promotion are staged too, so partial work never looks
complete.

## Status and installation

The repository is prepared as `@jbdevprimary/asset-fetch`, but that package name
has not received its first npm publication yet. After the first release:

```sh
npm install @jbdevprimary/asset-fetch
npx @jbdevprimary/asset-fetch --help
```

Until then, run the checkout directly:

```sh
git clone https://github.com/jbcom/asset-fetch.git
cd asset-fetch
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
```

Node.js 24 or newer is required. The package ships accurate ESM and CommonJS
entry points with declarations for both.

## Five-minute start

Search every available backend. An absent itch cache or NAS mount becomes a
warning; results from healthy sources are still returned.

```sh
node dist/cli.js find "pine tree" --type=3d
node dist/cli.js find "studio lighting" --source=polyhaven --type=hdri --json
```

Fetch a specific Poly Haven model variant and its referenced texture files:

```sh
node dist/cli.js polyhaven fetch ceramic_vase_03 \
  --resolution=1k --format=gltf --output=raw-assets/polyhaven
```

The files land under `raw-assets/polyhaven/ceramic_vase_03/`. A rerun skips
files whose size and MD5 still match.

## CLI reference

```text
asset-fetch find <query> [--source=itch|nas|polyhaven|all]
                         [--type=audio|2d|3d|hdri|texture|tool|other]
                         [--limit=20] [--json]
asset-fetch polyhaven fetch <id> [--resolution=1k] [--format=gltf] [--output=<dir>]
asset-fetch itch library
asset-fetch itch search [query] [--bucket=audio|pixel-2d|3d-psx|tool|other]
asset-fetch itch download <allowlist.json> [--dry]
```

The legacy top-level `library`, `search`, and `download` names remain aliases
for their `itch` forms. Commands reject unknown options and invalid values.
Batch download and extraction commands exit non-zero on partial failure.

### Owned itch.io assets

Create an itch.io API key, then expose it without committing it:

```sh
export ITCH_API_KEY=your-key
# or write ITCH_API_KEY=your-key to a gitignored .env in the working directory

asset-fetch itch library
asset-fetch itch search music --bucket=audio
asset-fetch itch download examples/allowlist.example.json --dry
asset-fetch itch download examples/allowlist.example.json
```

`itch library` paginates the owned-keys endpoint into
`.itch-cache/library.json`. The allowlist is a JSON array of exact owned pack
titles. Downloads prefer archives and fall back to loose WAV, MP3, OGG, or FLAC
files when a pack has no archive.

### Local assets-mcp catalog

Unified search reads the existing catalog; it never ingests or changes it.
Defaults:

| Setting | Default | Override |
| --- | --- | --- |
| SQLite catalog | `~/.local/share/assets-mcp/catalog.db` | `ASSET_FETCH_CATALOG_DB` |
| Asset root | `/path/to/assets` | `ASSET_FETCH_ASSETS_ROOT` |

`CATALOG_DB` remains a compatibility fallback for the database path. The
connection uses Node's built-in `node:sqlite` in read-only mode. Missing paths
produce a structured warning instead of breaking an unrelated workflow.

```sh
ASSET_FETCH_ASSETS_ROOT=/mnt/assets \
ASSET_FETCH_CATALOG_DB=/var/lib/assets-mcp/catalog.db \
asset-fetch find knight --source=nas --type=3d
```

### Poly Haven

Search is public and requires no API key. Poly Haven assets are CC0, but use of
the public API itself is governed separately by Poly Haven's
[API terms](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md),
including its current usage and attribution conditions. Review those terms for
your use case. Powered by [Poly Haven](https://polyhaven.com/).

The downloader accepts only HTTPS file URLs on Poly Haven's download hosts,
pins every redirect to HTTPS and the same host allowlist, and verifies the API's
size and MD5 before replacing a destination.

## Library API

### Unified discovery

```ts
import { findAssets } from "@jbdevprimary/asset-fetch";

const { results, warnings } = await findAssets("pine tree", {
  sources: ["nas", "polyhaven"],
  kind: "3d",
  maxResults: 12,
});
```

`findAssets` returns normalized `UnifiedAssetResult` rows and source-specific
warnings. Itch results require an `itchLibrary` array; call
`fetchOwnedLibrary`, or deserialize a previously generated cache, before using
that source in library code.

### Source-specific APIs

- `fetchOwnedLibrary`, `searchLibrary`, `classifyPack`, and `dedupeByGame`
  handle the owned itch.io library.
- `fetchItchAssets` downloads selected owned packs; `extractArchives` safely
  extracts ZIP, RAR, and 7z sources.
- `searchNasCatalog` queries the assets-mcp SQLite schema with style, category,
  armature, texture, and limit filters.
- `searchPolyhaven`, `listPolyhavenFiles`, and `fetchPolyhavenAsset` cover
  Poly Haven discovery and verified transfer.
- `promoteAssets`, `listExtractedAudioFiles`, and `writeAssetManifest` turn a
  game-specific selection into stable semantic slots.

All public functions and option/result types are exported from the package
root. See [Architecture](./docs/ARCHITECTURE.md) for boundaries and trust
decisions.

### Curating project assets

Promotion is intentionally a library operation: only the consuming game knows
which downloaded file should become `ambient-pad` or `player-hit`.

```ts
import {
  listExtractedAudioFiles,
  promoteAssets,
  writeAssetManifest,
} from "@jbdevprimary/asset-fetch";

const files = listExtractedAudioFiles("raw-assets/extracted");
const result = promoteAssets({
  targetDir: "public/assets/audio",
  apply: true,
  normalize: true,
  slots: [
    { name: "ambient-pad", sources: files.filter((file) => file.includes("calm-loop")) },
    { name: "player-hit", sources: files.filter((file) => file.includes("impact")) },
  ],
});
writeAssetManifest("public/assets/audio", result.manifest);
```

Promotion is a dry run unless `apply: true` is supplied. Slot names, duplicate
sources, extensions, and destination collisions are validated before mutation.
Applying a plan removes stale numbered variants and writes the manifest
atomically. See the runnable [examples](./examples/).

## Platform requirements

The library and CLI support current Node.js 24 releases on Linux, macOS, and
Windows; CI exercises all three. Optional workflows need host tools:

- ZIP extraction: `unzip`
- 7z extraction: `7z`
- RAR extraction: bundled `node-unrar-js`
- audio loudness normalization: `ffmpeg`

Native `fetch` handles HTTP transfers; `curl` is not required. Paths are
resolved with Node's cross-platform APIs, and archive validation recognizes
Unix absolute paths, Windows drive paths, backslashes, and parent traversal.

## Reliability and security

- Secrets and signed URLs are never logged. `ITCH_API_KEY` is read from the
  environment first and then a local `.env`.
- Remote filenames cannot escape caller-selected directories.
- Remote transfers use HTTPS, timeouts, bounded redirects, streaming writes,
  and post-transfer integrity checks.
- Existing downloads, extractions, and promoted assets survive failed retries.
- NAS access is read-only and fail-soft; invalid caller options still throw.
- Unified discovery preserves partial results and explains unavailable sources.

See [SECURITY.md](./SECURITY.md) for private vulnerability reporting and
[Troubleshooting](./docs/TROUBLESHOOTING.md) for common environmental failures.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs Biome formatting/lint/import checks, strict TypeScript,
behavioral tests with 100% statement/branch/function/line coverage for the core
library, a clean ESM/CommonJS build, and a package dry run. CLI integration
tests rebuild and execute the shipped `dist/cli.js`. CI additionally runs
Publint and Are the Types Wrong against the packed package.

Useful focused commands:

```sh
pnpm check          # formatting, lint, and import organization
pnpm typecheck      # strict TypeScript
pnpm test           # behavioral suite
pnpm coverage       # suite plus enforced coverage thresholds
pnpm build          # ESM, CommonJS, declarations, and CLI
pnpm pack:check     # inspect the package payload
```

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md), the
[Code of Conduct](./CODE_OF_CONDUCT.md), and the issue templates before opening
a pull request.

## Releases and license

Conventional commits drive Release Please. Merging its release pull request
creates a GitHub release; the release workflow rebuilds, verifies, and publishes
the exact tag to npm with provenance. The first publication still requires npm
package ownership/token setup; later releases can use npm trusted publishing.

Licensed under the [MIT License](./LICENSE).
