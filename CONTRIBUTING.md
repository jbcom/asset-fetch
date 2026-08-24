# Contributing

Thanks for taking the time to contribute.

## Getting set up

```sh
corepack enable
pnpm install
pnpm verify   # lint, typecheck, test, build — the same gate CI runs
```

Node and pnpm versions are pinned in `package.json` under `engines` and
`packageManager`. Use `corepack` rather than a globally installed pnpm so your
version matches CI.

## Making a change

1. Branch off `main`.
2. Write the test first. A bug fix should come with a test that fails without it.
3. Run `pnpm verify`. A change is not ready while any part of that is red.
4. Commit with [Conventional Commits](https://www.conventionalcommits.org):
   `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`. This is enforced by
   commitlint, and it is what drives the changelog and the next version number.
5. Open a pull request describing what changed and why.

## What gets reviewed

- Does it do what it says, and is there a test proving it?
- Does it keep the public API honest? A breaking change needs a `!` or a
  `BREAKING CHANGE:` footer.
- Are the types right for consumers? CI runs `publint` and
  `arethetypeswrong` because broken types only surface at integration time.

## Releases

Releases are automated. Merging a conventional commit to `main` opens a
release pull request; merging that publishes to npm with provenance. Do not
hand-edit versions or the changelog.
