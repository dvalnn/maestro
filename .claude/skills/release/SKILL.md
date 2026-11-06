---
name: release
description:
  Cut a maestro release, stable or `-rc.<n>` pre-release - release review, version bump, `just release`, push, the
  Forgejo and GitHub releases with their assets and notes, closing the milestone. Use when the owner asks to cut, ship
  or issue a release.
---

# Release

Versions are semver: a patch bump for a change that breaks nothing, a minor bump for one that breaks (`0.y.z` until a
1.0). A stable release `v<x.y.z>` is the Forgejo milestone of the same name. A pre-release `v<x.y.z>-rc.<n>` is an
interim build of the release a milestone is gathering, for field testing before it is promoted; it has no milestone, and
the promoted release is a new cut at `x.y.z`. Cutting either needs the owner's go, which also covers its push and
publish. Run every command from the repository root.

`<version>` below is the version without its `v`, `<tag>` is `v<version>`, and `<prev>` is the tag of the last release
of the same kind: the last stable for a stable, the last tag for a pre-release.

## Steps

1. **Ready.** `jj git fetch`. For a stable, every issue in the milestone is closed or moved to the next release's
   milestone, created if it does not exist; the milestone ids come from `forge.py api GET /milestones` (the `forgejo`
   skill). A pre-release has no gate: it cuts whatever `main` holds.
2. **Release review.** Step 6 of `docs/agents/implementation-loop.md`: one opus read-only subagent over
   `jj diff --from <prev> --to main@origin`. Accepted findings become issues in the milestone and land as their own
   changes before the cut. Done when no finding blocks the release.
3. **Notes.** Draft them in the scratchpad in the previous release's structure and voice (read it with
   `forge.py api GET '/releases?limit=1'`): a two-line lead naming the theme, `## Install or upgrade` with the pinned
   version, `## Upgrade notes` for every breaking change a user of the previous release must act on, `## Added`,
   `## Changed`, `## Fixed`, each bullet ending in its issue refs as forge links,
   `[#N](https://git.amorimcasa.org/tiago/maestro/issues/N)`, since GitHub links a bare `#N` to its own issue. Show the
   owner the notes and the review's findings before publishing.
4. **Bump.** One change, `chore(release): bump to <version>`, on top of `main`: the `version` of every
   `packages/*/package.json` and `packs/classics/package.json`, the pinned version in `INSTALL.md`, and in
   `skills/maestro/SKILL.md` the `checked against` line and the classics pack's version. `bun install` refreshes
   `bun.lock`. `jj show <prev>` is the previous bump to match; a `grep` for the old version finds no stray.
5. **Build.** `mise exec -- just release` runs the gate, builds `dist/` and smoke-tests the install. It must end with
   `smoke: passed`.
6. **Push.** `jj bookmark set main -r <bump>`, `jj git push --bookmark main`.
7. **Publish.** From `dist/`, so each asset keeps its file name:

   ```sh
   fj release create <tag> --create-tag <tag> --branch main [--prerelease] \
     --body "$(cat <notes>)" -a SHA256SUMS -a install.sh -a maestro-linux-x64.gz -a maestro-skill.tar.gz \
     -a classics-<v>.tar.gz -a maestro-classics-<v>.tgz -a maestro-ir-<v>.tgz -a maestro-sdk-<v>.tgz -a harnesses \
     -a maestro-host-repo-sdk-<v>.tgz
   ```

   `--prerelease` is for an `-rc.<n>` only. The assets are every file in `dist/`, and `install.sh` fails on any that
   `SHA256SUMS` names but the release lacks; `ls dist` against the list catches one the build added.

8. **GitHub.** `scripts/github-sync.sh <bump>` points `next` at the bump (the `github` skill). Then, from `dist/`:

   ```sh
   gh release create <tag> --repo dvalnn/maestro --target <bump commit id> [--prerelease] --notes-file <notes> *
   ```

9. **Verify.** Download one asset from the GitHub release, the one users install from, and check it with `sha256sum -c`
   against the published `SHA256SUMS`. `jj git fetch` brings the forge's tag home.
10. **Close.** For a stable, `forge.py api PATCH /milestones/<id> '{"state": "closed"}'`. Reinstall the owner's binary
    with `MAESTRO_RELEASE_DIR=$PWD/dist sh install.sh`.

## Gotchas

- A pushed description says `Refs: #N` and closes nothing; close each issue with `fj issue close N -w`.
- An issue with an open dependency refuses to close (HTTP 412); close its blocker first.
- `just release` runs the full gate, so a flaky test fails the build; rerun once, and file the flake if it repeats.
- `fj` creates the tag on the forge, and jj creates none. The tag reaches the local repository only through
  `jj git fetch`.
