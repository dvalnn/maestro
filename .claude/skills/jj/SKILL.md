---
name: jj
description:
  The jj conventions of this colocated repository and the jj behaviour that surprises - one change per slice, revsets,
  bookmarks, pushing. Use when committing, describing, rebasing or pushing a change, or when a git command is denied.
---

# jj

This repository is jj-colocated. `git` is denied where jj owns the operation, by a hook that answers with the jj command
that does it. Read-only git is untouched. `ALLOW_GIT=1 <command>` is the deliberate override, for a scratch repository,
never this one.

## Changes

One change per slice or per fix. Collapse a review round onto the change it corrects (`jj squash`) rather than stacking
fixups. Split a change only where it genuinely divides, such as a mechanical rename held apart from the edit that needed
it. The description follows CLAUDE.md "Commit messages"; an issue goes last as `Refs: #N`.

Push only when the owner asks: `jj bookmark set main -r <change>`, then `jj git push`.

## What the denial message cannot tell you

- **jj runs no git hooks.** A `post-commit` or `pre-push` silently does nothing for every push jj drives.
- **git resolves `@` to `HEAD`, which jj parks one commit behind the working copy.** A git range ending at `HEAD` misses
  the change in progress; ask jj for the tip instead.
- **`jj bookmark delete` propagates** to the remote on the next push. `jj bookmark forget` drops the local bookmark and
  leaves the remote one alive.
- **A detached HEAD in `git status` is normal here.**
- **`~` in a revset is set difference.** `main~8` is `main` minus a commit named `8`; the last eight are
  `ancestors(main, 8)`.
- **A rewritten base strands what sits on it.** After a fetch abandons the old commit, `jj rebase -s <change> -d main`.
