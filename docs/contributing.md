---
title: Contributing
description: Set up asset-fetch, validate a change, and contribute through the protected workflow.
---

## Local workflow

```sh
mise install
pnpm install --frozen-lockfile
pnpm verify
pnpm docs:build
```

`pnpm verify` is the library gate: Biome, Markdown linting, strict TypeScript, tests with coverage,
the dual-format build, the runnable examples, package validation, and a clean-consumer runtime check.
`pnpm docs:build` validates and renders the Sourcey site.

Branch from `main`, make a focused Conventional Commit, open a pull request, and keep the branch
current by merging `main` into it when necessary. Do not hand-edit versions or `CHANGELOG.md`:
release-please owns both.

## Trust boundaries need tests

A change that touches a path, URL, archive member or credential keeps its containment test, and a new
write destination goes through `assertWithin`. A new gate is only evidence once it has been seen to
fail on an injected defect and pass again on the restored code.
