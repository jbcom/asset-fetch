# Agent notes

## Toolchain and validation

Support maintained Node.js 22, 24 and 26, with a minimum of 22.16.0 for the SQLite catalog.
Use Node 26 and pnpm 12 as local defaults in `mise.toml`; Node support is a range in `package.json`.
The workspace contains the published library and the private Sourcey site in `docs/`.
Run `pnpm install --frozen-lockfile`, then `pnpm verify` for lint, Markdown lint,
strict types, coverage, dual-format build, examples and packed-consumer validation.
Run `pnpm docs:check` for the documentation site. Sourcey emits `docs/dist/`.
The root `llms.txt` provides repository orientation separately from the generated site files.

## Core invariants

- Asset roots must be explicitly supplied or configured with `ASSET_FETCH_ASSETS_ROOT`.
- Keep containment checks in `src/safety.ts` on extraction, download and promotion paths.
  Reject symlink escapes and dangling symlinks; do not relax these checks.
- Promotion defaults to dry-run. Only an explicit apply option writes assets.
- Catalog availability is reported as structured data, including an unavailable reason.
- Credentials are supplied by callers or their local configuration; never log them.
- Keep ESM and CommonJS runtime exports and declarations equivalent.

## Keeping docs and tests in sync

Public API changes need tests in `tests/`, updates to `docs/API.md` and
`docs/ARCHITECTURE.md`, and matching examples and packed-consumer checks.
`tests/cli.test.ts` rebuilds `dist/` before exercising the CLI.
`scripts/build.mjs` emits ESM with TypeScript and CommonJS with esbuild;
it mirrors `.d.ts` declarations into `.d.cts` with rewritten relative imports.
Sourcey paths resolve relative to `docs/`; keep all navigation links typed.

## Commits and releases

Use Conventional Commits with hooks enabled. `simple-git-hooks`, `lint-staged`
and commitlint are installed by `pnpm install`; never bypass them.
Keep release automation disabled during initial import. Release-please owns
subsequent version changes. Publishing requires the repository owner's release process.
