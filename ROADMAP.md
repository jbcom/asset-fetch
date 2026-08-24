# asset-fetch roadmap

Current state (v0.1.0, shipped): the itch.io backend only — owned-library
fetch + curated promotion. This is what unblocked otterly-chaotic's
Tone.js → Howler audio swap and is the reason this package exists today.

Everything below is planned, not yet built. Documented here so any future
agent picking up this package (or a fresh session) has the design intent
without re-deriving it from scratch.

## Planned: NAS backend

Read-only query against the existing `assets-mcp` SQLite catalog
(`~/.local/share/assets-mcp/catalog.db`, schema in
`~/src/assets-management/assets-mcp/src/assets_mcp/catalog.py`) via
Node's built-in `node:sqlite` (no native-compiled dependency —
`better-sqlite3` was considered and rejected for exactly this reason;
`node:sqlite` needs Node >=24, which this package already requires).

Do NOT reimplement ingestion (`ingest.py`, `glb_reader.py`,
`render_preview.py`) — those stay Python/assets-mcp's job. This package
only *reads* the catalog assets-mcp already built, exposing it as
`searchNasCatalog(query, filters)` returning the same row shape
`catalog.py`'s `search()` does (path, name, style, category, pack,
source, mesh/vertex/texture counts, preview_path, tags).

Design questions to resolve before building:
- DB is SQLite WAL mode — confirm node:sqlite handles concurrent
  read access safely while assets-mcp's Python process may also have
  it open.
- `/Volumes/home` is an SMB mount that can be absent (network/VPN
  down, remote work) — `searchNasCatalog` must fail soft (empty
  results + a clear "NAS not mounted" reason), never throw, matching
  itch-fetch's "never block a game's CI on an unreachable source"
  philosophy.

## Planned: Polyhaven backend

Public, unauthenticated JSON API (`https://api.polyhaven.com`) — no
API key needed. Confirmed during design (2026-08-03):

```
GET /types                    -> ["hdris","textures","models"]
GET /assets?t=hdris           -> { slug: { name, categories, tags, ... }, ... }
GET /files/<slug>              -> { <resolution>: { <format>: { url, md5, size } } }
```

`searchPolyhaven(query, { type })` filters the `/assets` response
client-side (Polyhaven's API has no server-side text search — same
constraint noted for itch.io's public catalog). `fetchPolyhavenAsset`
downloads via the direct `dl.polyhaven.org` URLs (md5-verified, same
idempotency pattern as `fetchItchAssets`). No audio assets on
Polyhaven — this backend is for the fleet's 3D games needing
HDRIs/textures/models, not relevant to otterly-chaotic.

## Planned: unified search CLI

`asset-fetch find <query> [--source itch|nas|polyhaven|all] [--type audio|3d|hdri|texture]`
— one command fanning out to whichever backends are relevant/reachable,
merging results into one ranked list. Per-backend commands
(`asset-fetch itch library`, etc.) stay available underneath for
scripted/CI use where a specific source is already known.

## Planned: TOON output mode

Global `--format toon` flag (default stays JSON for `--format json`
scripts/piping compatibility) emitting Token-Oriented Object Notation
instead of JSON for CLI output consumed by an LLM agent rather than a
script — meaningfully fewer tokens per row than JSON for the
tabular/repeated-key search-result shape this CLI mostly produces.
Ties into the broader "CLI over MCP" preference recorded in
`~/.claude/CLAUDE.md` — a fast, scriptable CLI an agent shells out to,
rather than an MCP server round-trip, with TOON shrinking the
per-call token cost further. This package's own CLI is the pilot for
that pattern; if it proves out, other fleet CLIs (itch parts of this
package included) should adopt the same `--format toon` convention.

## Explicitly out of scope (for this package, always)

- Publishing/writing to itch.io, the NAS, or Polyhaven — read/fetch
  only, never a publish path.
- Re-implementing assets-mcp's GLB introspection or preview rendering.
- MCP server mode — this stays a CLI + library, per the explicit
  design decision (2026-08-03) to keep it distinct from assets-mcp's
  interactive Python MCP server.
