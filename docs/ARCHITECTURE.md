# Architecture

`asset-fetch` separates discovery, transfer, extraction, and curation so a
project can use only the layers it needs.

```text
itch.io API ─┐
NAS SQLite ──┼─> normalized search results
Poly Haven ──┘            │
                          ├─> verified raw assets
                          └─> project-owned promotion script -> public assets
```

## Backend boundaries

- `library.ts` reads and searches the caller's owned itch.io library.
- `nas.ts` opens the assets-mcp catalog read-only. It never ingests, modifies,
  or renders NAS assets. An absent mount or database is a normal, structured
  unavailable result.
- `polyhaven.ts` maps the public Poly Haven API and downloads one selected
  format/resolution plus its required include files.
- `search.ts` converts those three source-specific shapes into
  `UnifiedAssetResult`. Backend failure produces a warning while usable results
  from other sources remain available.

## Trust boundaries

Remote names, URLs, archive entries, checksums, API responses, and catalog rows
are untrusted. Transfers require HTTPS, Poly Haven redirects remain on an
allow-listed host, and downloaded files are moved into place only after size
and optional MD5 verification. Archive member paths are inspected before a
staged extraction replaces an earlier result.

MD5 here is an upstream file-integrity identifier, not a cryptographic trust
claim. It detects incomplete or changed transfers; it does not authenticate a
publisher.

## Why promotion is library-only

The toolkit can discover and fetch assets generically, but deciding that a
specific file is a game's `ambient-pad` or `player-hit` is product content—not
infrastructure. Each game keeps a small promotion script that declares those
semantic slots. `promoteAssets` supplies validation, staging, normalization,
idempotency, and the manifest format without pretending the mapping is generic.

## Packaging

TypeScript emits ESM JavaScript and declarations. esbuild emits parallel
CommonJS modules, and the build mirrors declarations as `.d.cts` so CommonJS
consumers receive accurate module-kind types. Package exports expose only the
root API and `package.json`; implementation modules remain private.
