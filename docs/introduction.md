---
title: asset-fetch
description: Typed CLI and library for finding, verifying, extracting and curating game assets from itch.io, Poly Haven and a local 3D catalog.
---

asset-fetch finds game assets across the sources you use, fetches them defensively, and promotes a
deliberate subset into a project. It is a Node.js library and a CLI, built for local scripts and CI.

## What it unifies

| Source | What you get | Availability model |
| --- | --- | --- |
| Your owned itch.io library | Signed archive downloads, extracted and audited | Needs an API key; cached locally |
| A local 3D catalog (game-asset-mcp) | Read-only full-text search over a SQLite catalog | Needs an asset root; absent is a warning |
| Poly Haven | CC0 models, textures and HDRIs, verified downloads | Public; no key |

Each source keeps its own trust and availability model. A source that is missing becomes a warning,
and the others still answer.

## Why use it?

| Problem | What asset-fetch does |
| --- | --- |
| A download dies half way and leaves a corrupt file | Streams to a private temp file, verifies size and MD5, renames into place |
| A hostile archive writes outside its directory | Checks entry names, then audits the real extracted tree, symlinks included |
| A malformed key reaches an HTTP header | One gate, `sanitizeKey`, between configuration and `Authorization` |
| A script only works on the author's machine | No default paths: the asset root is explicit, the catalog default is a standard location |
| Re-running a fetch re-downloads everything | Idempotent by size and MD5, extraction by source marker |

Start with [Getting started](./getting-started/), then use the [API reference](./API/) for
signatures and the [architecture notes](./ARCHITECTURE/) for the guarantees behind them.
