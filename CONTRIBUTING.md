# Contributing

For whoever sends a pull request to maestro on GitHub.

- Branch from `next` and open the PR against it. `next` is `main` of the private forge maestro is built on, as of the
  last sync.
- `just check` must pass and leave the tree unchanged, since it rewrites files to fix format and lint failures. CI runs
  `just ci` on every PR, which fails on any file `just check` changed or added. `mise install` pins the toolchain, then
  `bun install`.
- A merged PR lands on the forge and comes back to `next` at the next sync, under new commit ids. You stay the author of
  your commits.
- Commit messages follow [`CLAUDE.md`, Commit messages](CLAUDE.md#commit-messages); a commit that does not is reworded
  when it lands.
- Issues are read and answered, but planned on the forge, so a reply can take a while.
- maestro is MIT-licensed ([`LICENSE`](LICENSE)), and a contribution is licensed the same way.
