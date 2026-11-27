---
name: release
description:
  Cut a maestro release, stable or `-rc.<n>` pre-release - perform `.maestro/release.ts`, show the owner its notes and
  review, rule with `maestro approval`, then the GitHub release and reinstall. Use when the owner asks to cut, ship or
  issue a release.
---

# Release

Versions are semver: a patch bump for a change that breaks nothing, a minor bump for one that breaks (`0.y.z` until a
1.0). A stable release `v<x.y.z>` is the Forgejo milestone of the same name. A pre-release `v<x.y.z>-rc.<n>` is an
interim build of the release a milestone is gathering, for field testing before it is promoted; it has no milestone, and
the promoted release is a new cut at `x.y.z`. Cutting either needs the owner's go; their `ok` ruling on the approval is
the go for its push and publish. Run every command from the repository root.

`.maestro/release.ts` performs the release: the milestone gate, the review, the forge notes, the bump, `just release`,
the push to `main`, the forge release and its asset check, and closing the milestone.
`maestro compose .maestro/release.ts --help` holds its params and what each node does. This skill is the operator's part
around it.

`<version>` below is the version without its `v`, `<tag>` is `v<version>`, and `<prev>` is the tag of the last release
of the same kind: the last stable for a stable, the last tag for a pre-release (`jj tag list`).

## Steps

1. **Perform.** `jj git fetch`, then
   `maestro perform .maestro/release.ts --version <version> --prev <prev> [--prerelease] --detach`, and follow it with
   `maestro wait <id>`. Done when `maestro approval` lists its `publish` approval.
2. **Show.** `maestro approval` lists the request with the path of each thing it publishes: the notes, the review, the
   bump `changeset` and `dist`. Give the owner the notes and the review's findings. A finding the owner accepts becomes
   an issue in the milestone; rule `reject` and cut again once it lands.
3. **Rule.** On the owner's word, `maestro approval <id> ok`, or `maestro approval <id> reject "<reason>"`. Done when
   the concert settles `ok`: the bump is on the forge's `main`, the forge release holds every `dist/` file, and a
   stable's milestone is closed.
4. **GitHub.** `jj git fetch` brings the tag home, and `<bump>` is `jj log -r <tag>`'s commit. Copy the notes for GitHub
   so they link nothing on the forge: drop the issue refs, since GitHub links a bare `#N` to its own issue, and point
   the `INSTALL.md` link at `https://github.com/dvalnn/maestro/blob/<tag>/INSTALL.md`. `scripts/github-sync.sh <bump>`
   points `next` at the bump (the `github` skill). Then, from the `dist` directory
   (`maestro artifact show <id> release --path`):

   ```sh
   gh release create <tag> --repo dvalnn/maestro --target <bump commit id> [--prerelease] --notes-file <github notes> *
   ```

5. **Verify.** Download one asset from the GitHub release, the one users install from, and check it with `sha256sum -c`
   against the published `SHA256SUMS`.
6. **Reinstall** the owner's binary once no concert runs: `MAESTRO_VERSION=<tag> sh install.sh`, as `INSTALL.md` shows.

## Gotchas

- The concert publishes as `MAESTRO_TM_TOKEN` and signs the bump with the key `MAESTRO_TM_SIGNING_KEY` names, both the
  tour manager's. Without the key the bump is unsigned, and `main` refuses it at the `push` node.
- The concert reads `origin/main` as the checkout last fetched it. An unfetched newer `main` fails the `push` node as a
  non-fast-forward; `jj git fetch`, then `maestro resume <id>`.
- `just release` runs the full gate in the `release` check, so a flaky test fails it; `maestro resume <id>` once, and
  file the flake if it repeats.
- The milestone gate refuses while an issue is open. A pushed description says `Refs: #N` and closes nothing; close each
  with `forge.py api PATCH /issues/N '{"state": "closed"}'`. An issue with an open dependency refuses to close (HTTP
  412); close its blocker first.
- The forge creates the tag, and jj creates none. The tag reaches the local repository only through `jj git fetch`.
