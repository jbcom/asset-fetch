# Contributing

Thanks for taking the time to contribute.

## Getting set up

```sh
corepack enable
pnpm install
pnpm verify   # format/lint, types, 100% core coverage, build, package inspection
```

Node.js 22, 24 and 26 are supported, starting at 22.16.0. `engines` declares that
range; `packageManager` selects pnpm. Use `corepack` so your pnpm
version matches CI.

## Making a change

1. Branch off `main`.
2. Write the test first. A bug fix should come with a test that fails without it.
3. Run `pnpm verify`. A change is not ready while any part of that is red.
   When an example changes, run it against the freshly built package too.
4. Commit with [Conventional Commits](https://www.conventionalcommits.org):
   `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`. Release Please uses
   these prefixes to drive the changelog and the next version number.
5. Open a pull request describing what changed and why.

## What gets reviewed

- Does it do what it says, and is there a test proving it?
- Does it keep the public API honest? A breaking change needs a `!` or a
  `BREAKING CHANGE:` footer.
- Are the types right for consumers? CI runs `publint` and
  `arethetypeswrong` because broken types only surface at integration time.
- Does it preserve partial results and existing files when a backend, download,
  extraction, or normalization step fails?
- Are user-controlled URLs, paths, archive members, and credentials handled at
  the trust boundary rather than assumed safe?

## Releases

Releases are automated. Merging a conventional commit to `main` opens a
release pull request; merging that publishes to npm with provenance. Do not
hand-edit versions or the changelog.
