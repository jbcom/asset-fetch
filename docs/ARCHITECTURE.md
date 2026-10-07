---
title: Architecture
description: Module boundaries, trust boundaries and the invariants behind asset-fetch.
---

`asset-fetch` separates discovery, transfer, extraction and curation so a project can use only the
layers it needs.

```text
itch.io API ──┐
local catalog ┼─> normalized search results
Poly Haven ───┘            │
                           ├─> verified raw assets
                           └─> project-owned promotion script -> public assets
```

## Module boundaries

- `library.ts` reads and searches the caller's owned itch.io library.
- `fetch.ts` downloads selected packs and extracts archives.
- `catalog.ts` opens a game-asset-mcp SQLite catalog read-only. It never ingests, modifies or renders
  assets. An absent mount or database is a normal, structured unavailable result; an unconfigured
  asset root is a caller error.
- `polyhaven.ts` maps the public Poly Haven API and downloads one selected format and resolution plus
  its required include files.
- `search.ts` converts those three source-specific shapes into `UnifiedAssetResult`. A backend that
  fails or is not configured produces a warning while usable results from other sources remain.
- `safety.ts` holds the guards shared by all of the above: path containment, the extraction audit and
  the credential gate.
- `promote.ts` copies a project's chosen files into stable slots.

## Trust boundaries

Remote names, URLs, archive entries, checksums, API responses and catalog rows are untrusted.

- **Transfers** require HTTPS. Poly Haven redirects remain on an allow-listed host. Downloaded files
  are moved into place only after size and optional MD5 verification.
- **Destination paths** never come directly from remote data. Remote filenames are reduced to a
  basename and slugified, and every write destination goes through `assertWithin` first.
- **Extraction** is defended twice. Archive member names are checked lexically before the extractor
  runs, which stops `..` and absolute names. The extractor then writes into a private staging
  directory, and `assertExtractionContained` audits what it actually produced: every entry is
  `lstat`ed, its real path is resolved, and anything outside the staging directory, including a
  symlink member that points elsewhere, fails the whole archive. Only a clean tree is renamed into
  place. The lexical check alone cannot see a symlink member, which is why both exist.
- **Credentials** pass through `sanitizeKey`, the single gate between an environment or `.env` value
  and an `Authorization` header. A malformed value is treated as absent, never sent.

MD5 here is an upstream file-integrity identifier, not a cryptographic trust claim. It detects
incomplete or changed transfers; it does not authenticate a publisher.

## Failure semantics

Environmental states are results, not exceptions: a missing catalog, an absent mount, a failed
download in a batch, an archive that fails extraction. They are counted or warned about so the rest of
the work proceeds. Programmer errors throw: an invalid `maxResults`, duplicate sources, an unsafe slot
name, an unconfigured asset root passed to `searchCatalog`.

## Why promotion is library-only

The toolkit can discover and fetch assets generically, but deciding that a specific file is a
project's `ambient-pad` or `player-hit` is product content, not infrastructure. Each project keeps a
small promotion script that declares those semantic slots. `promoteAssets` supplies validation,
staging, normalization, idempotency and the manifest format without pretending the mapping is generic.

## Packaging

TypeScript emits ESM JavaScript and declarations. esbuild emits parallel CommonJS modules, and the
build mirrors declarations as `.d.cts` so CommonJS consumers receive accurate module-kind types.
Package exports expose only the root API and `package.json`; implementation modules remain private.
The `asset-fetch` binary is `dist/cli.js`.
