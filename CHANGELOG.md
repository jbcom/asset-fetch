# Changelog

All notable changes are documented here. Releases follow
[Semantic Versioning](https://semver.org/) and are generated from Conventional
Commits by Release Please.

## [Unreleased]

### Added

- Unified search across an owned itch.io library, the read-only assets-mcp
  SQLite catalog, and Poly Haven.
- Verified Poly Haven model, texture, and HDRI downloads.
- Atomic, integrity-checked itch.io downloads and staged archive extraction.
- Safe, idempotent audio promotion with optional ffmpeg normalization.
- Dual ESM/CommonJS packaging, strict static analysis, and full core-library
  coverage gates.

### Changed

- The package is now named `@jbdevprimary/asset-fetch` and requires Node.js 24
  or newer.
