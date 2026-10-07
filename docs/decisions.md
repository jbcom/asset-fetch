---
title: Decisions
description: Why asset-fetch is shaped the way it is.
---

## 2026-10-07: unscoped npmjs name `asset-fetch`

The package is open source under the MIT licence and targets npmjs under the unscoped name
`asset-fetch`, which was free. The planned first release is 0.2.0. Publication is a separate,
owner-authorized step. Subsequent releases use release-please and OIDC trusted publishing
with provenance.

## Path containment and key hygiene are part of the package

`assertWithin` runs before every write destination, and `assertExtractionContained` runs after
extraction and before the atomic rename. Both are exported. The earlier check only compared archive
entry names lexically, which cannot see a symlink member that points outside the extraction root; the
audit resolves real paths with `lstat` and `realpath` and never follows a symlink.

Two choices in the audit:

- **A symlink whose target cannot be resolved is refused**, not allowed. Its destination cannot be
  proven to be inside the tree, and a pack with a dangling link is not worth a partial acceptance.
- **One check covers every entry**, symlink or not. A non-symlink entry cannot resolve outside a tree
  that is never entered through a link, so a separate branch for it would be unreachable and untestable.

`sanitizeKey` with `/^[A-Za-z0-9._-]{8,128}$/` is the single gate between a configured API key and the
`Authorization` header. The `.env` parser keeps its `export` prefix, CRLF and inline-comment handling,
and a missing or malformed key stays `undefined` rather than throwing, so callers print their own
message. A malformed environment value falls through to `.env` instead of ending the lookup.

## No machine-specific default paths

The asset root has no default. It comes from the `assetsRoot` option or `ASSET_FETCH_ASSETS_ROOT`, and
`searchCatalog` throws a message naming both when neither is set. `findAssets` reports the same message
as a warning instead, so an unconfigured catalog does not stop an itch.io or Poly Haven search. A test
scans every shipped text file for mount points, home directories and the previous catalog location.

The catalog default is `~/.local/share/game-asset-mcp/catalog.db`, the path game-asset-mcp (the tool
that writes this schema) uses. That tool does not consult `XDG_DATA_HOME`, so neither does this one:
the point of the default is that the two agree without configuration.

## The `nas` source is now `catalog`

The backend reads any game-asset-mcp catalog, wherever it is stored, so naming it for one kind of
storage was wrong and tied the public API to a private setup. `AssetSource` is `"catalog"`, the option
is `catalog`, and the functions are `searchCatalog` and `resolveAssetsRoot`. This was done before the
first npmjs release so no published API changes.

## Toolchain: maintained Node.js 22, 24 and 26, pnpm 12

`engines` is `>=22.16.0` with no ceiling and `@types/node` stays on 24. The shipped catalog
uses the [`DatabaseSync` timeout option](https://nodejs.org/docs/latest-v22.x/api/sqlite.html#new-databasesyncpath-options),
added in 22.16.0. Catalog imports are part of the root entry point, so the package-wide range
covers this requirement even when a caller only uses remote sources. This is a lower bound,
not an exact patch pin or a promise to support obsolete Node lines.
CI runs the full gate on maintained Node.js 22, 24 and 26 on Linux and on Node 26 on Windows,
because the package resolves paths and spawns archive tools. All selectors use majors;
Node 26 is the local default. Verification also runs locally at the 22.16.0 floor.
TypeScript is 7 (native) with `moduleResolution: bundler`; Vitest is 5.

## Initial release automation

Release, CD and Automerge remain disabled during the initial import. Their jobs
also have explicit false guards because GitHub cannot disable workflows absent
from the default branch. The owner must remove those guards and enable the
workflows when authorizing the first release. No initial tag or publish is automated.
