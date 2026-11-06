---
name: github
description:
  The public GitHub repository `dvalnn/maestro` - syncing its `next` branch from the forge, landing a GitHub PR on the
  forge, crediting its contributor, and the one-time setup. Use when pushing to GitHub, when a GitHub PR or issue needs
  handling, or when a GitHub release is published.
---

# GitHub

[`dvalnn/maestro`](https://github.com/dvalnn/maestro) is where users install from and where outside PRs arrive. The
forge stays the source of truth: only this side pushes to GitHub, and a commit merged there counts once it lands on the
forge's `main`. Pushing to GitHub is public, so it needs the owner's ask; a release's go covers its own sync.

GitHub holds one branch, `next`, the default branch and every PR's target: `main` as of the last sync, plus any GitHub
merge not yet landed. Tags and releases come from the `release` skill.

## Setup

Once, by the owner, who holds the GitHub login:

```sh
jj git remote add github git@github.com:dvalnn/maestro.git
gh auth login
scripts/github-sync.sh
gh repo edit dvalnn/maestro --default-branch next --enable-rebase-merge --enable-merge-commit=false \
  --enable-squash-merge=false
```

Rebase merging alone keeps each contributor commit's author and author time, which is how the sync script pairs it with
its landed copy.

## Sync

`scripts/github-sync.sh [<rev>]` points `next` at `<rev>` of `main@origin`, `main@origin` by default. It refuses while
`next` holds a commit not landed on `<rev>`, listing each. `--landed` overrides that, for a commit landed squashed or
reworked. After the push it abandons the GitHub commits it replaced.

## Intake

1. The owner reviews the PR and merges it into `next` with "Rebase and merge" once CI passes.
2. `jj git fetch --remote github`. The new commits are `::next@github ~ ::main@origin`.
3. `jj duplicate -r '::next@github ~ ::main@origin' -o main@origin`, which prints the copies' change ids.
4. Reword each copy to CLAUDE.md "Commit messages" with `jj describe`, a forge issue as `Refs: #N`. The author stays the
   contributor. Where the owner becomes the author, by squashing commits together or reworking one, add
   `Co-authored-by: <name> <id>+<handle>@users.noreply.github.com`, the id from `gh api users/<handle> --jq .id`.
5. `mise exec -- just check`, then land as any change: `jj sign -r '<first>::<last>'`, `jj bookmark set main -r <last>`,
   `jj git push --remote origin -b main`.
6. `scripts/github-sync.sh`, with `--landed` if step 4 squashed or reworked. Comment on the PR with the landed commit.

GitHub issues are read and answered by hand; there is no triage procedure for them. Contributors read `CONTRIBUTING.md`;
keep it in step with this procedure.

## Gotchas

- GitHub links each `#N` in a pushed description to its own issue #N, and a closing keyword would close it. That is why
  descriptions say `Refs: #N`, and release notes link forge issues by URL.
- `next@github` stays untracked. Tracked, `jj rmain` would rebase a GitHub merge onto `main` and `jj git push --tracked`
  would push it back.
- jj pushes no tags. `gh release create --target <commit>` makes the tag on GitHub, once `next` holds the commit.
