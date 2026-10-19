# Wave 10 review: live view, single binary, lane preparation and the repertoire

One opus read-only pass over `jj diff --from yxmnytoz --to zsprtxnk`: S10 `watch` with thinking and tool input events
and the render-text live view, S11 part 1 the single binary with its embedded SDKs, the `stub` harness, `--version` and
`just release`, the wave 9 fixes, H1 `target.prepare` and `target.sparse`, S9a the repertoire pack with `just pack` and
`acceptance/`, and S9b `v_model` with labelled groups. The code agrees with itself across the six changes: `watch`
renders the labelled groups and the prepare progress events, `prepare` reuses the check runner, and the wave 9 fixes
landed. NFR-05 and HOST-03 hold: `prepare` runs sandboxed with validated binds and no write to the lane's git dir,
`sparse` is set host-side before any sandbox runs, the `stub` harness runs in bubblewrap, and the binary ignores
`bunfig.toml`. Checked and left alone: the exit codes (each program keeps its own contract), the sandbox process scans
(H1 merged them), the `GIT_ENV` and toy-repo helpers (their clocks and layouts differ on purpose), the embedded SDK's
exports, and prepare's absence from the resume key, which matches all host config. The faults sit at the seam between
the release and the pack it is meant to ship, in INSTALL.md and the docs the wave never reached, and in two pairs of
helpers written twice.

## Findings

| #   | Kind | Finding                                                                                                   | Verdict                                                                                          |
| --- | ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | seam | `just release` builds neither the repertoire tarball nor the skill tarball INSTALL.md installs            | Fixed by S11 part 2, which landed after this range                                               |
| 2   | doc  | INSTALL.md promises a spend-free stub run that `review` and `v_model` cannot finish; `stub` is unnamed    | Accepted                                                                                         |
| 3   | doc  | INSTALL.md step 4 disagrees with the pack README, misses `prepare`, `sparse` and `v_model`, keeps a TODO  | Accepted; S11 part 2 had fixed most of it                                                        |
| 4   | doc  | ADR 0002 says external files cannot reach the binary's embedded SDK                                       | Accepted                                                                                         |
| 5   | code | `scripts/pack.ts` re-implements the loader's glue bundle and the fixture's manifest, with another exit    | Accepted in part: one shared bundler-message formatter; the script keeps its own exit codes[^k1] |
| 6   | code | Control characters are escaped twice, and the two escapes disagree on newlines                            | Accepted                                                                                         |
| 7   | doc  | Requirements SDK-07 and the sssf mapping table still promise checked prompt templates                     | Accepted                                                                                         |
| 8   | doc  | The compose README describes `SCOPE.key` for `parMap` only                                                | Accepted                                                                                         |
| 9   | doc  | GLOSSARY, two READMEs and a lanes comment describe prepare, sparse and the live view's cut as they aren't | Accepted                                                                                         |
| 10  | doc  | Architecture 3, port plan 2 and sdk-spec 15 are stale on packs, the live view and the ported workflows    | Accepted                                                                                         |

## Detail

### 1. `just release` ships no repertoire or skill tarball

- **Where:** `justfile:15-33` (the `release` recipe), `INSTALL.md:27-28` and `INSTALL.md:38-41`,
  `scripts/smoke-install.sh` (no pack step).
- **Citation:** K286, K308 and K309 (the release carries the repertoire pack and the skill as assets); PACK-01.
- **Failure:** `release` builds the binary, the three package tarballs and `SHA256SUMS`, and nothing else. INSTALL.md
  lists `repertoire-<version>.tar.gz` and `maestro-skill.tar.gz` among the assets and extracts both in step 3, so a
  reader following it finds neither file. The smoke never loads a pack built by `just pack` into the compiled binary, so
  the seam between S9a's bundle and S11's loader is untested where it ships.
- **Fix:** `release` runs `just pack packs/repertoire`, tars its `dist` as `repertoire/` and the skill directory as
  `maestro-skill.tar.gz`, both into `SHA256SUMS`; the smoke extracts the pack and runs `maestro plan` on
  `repertoire.build_then_repair` with the binary.

### 2. The stub profile cannot run every composition, and `stub` is unnamed

- **Where:** `INSTALL.md:56-57`; `packages/host-repo/src/host/agent.ts:326-329` (a missing declared output fails an ok
  agent); `docs/architecture.md:489-490` (Harness adapters).
- **Citation:** K275 (the built-in `stub` harness replies an ok envelope and writes nothing); architecture 12.
- **Failure:** INSTALL.md says `--profile stub` runs "to spend nothing", read as a dry run of any composition. A stub
  agent writes no declared output, so `review` and `v_model`, whose agents declare outputs, fail at their first agent;
  only compositions whose agents declare none finish. Architecture 12 names pi and Claude Code as the harnesses and not
  `stub`, which K275 made a built-in contract of the binary.
- **Fix:** INSTALL.md names the compositions the stub runs to completion and says the others fail at their first agent
  with outputs; architecture 12 adds `stub` beside pi and Claude Code.

### 3. INSTALL.md step 4 is incomplete and contradicts the pack README

- **Where:** `INSTALL.md:49-59`; `packs/repertoire/README.md:3-4`.
- **Citation:** K279 (the pack README holds its roles and params); K284 (relative paths anchor at the config file);
  HOST-16 and H1 (`target.prepare`, `target.sparse`); S9b (`v_model` takes the lens and skeptic model params).
- **Failure:**
  - INSTALL.md puts `packs` in the user file; the pack README puts it in a workspace's `.maestro/config.yaml`.
  - "Paths are not expanded, so write the absolute path" reads as a rule; K284 anchors relative paths at the file.
  - The `target` sample at line 55 lacks `prepare` and `sparse`, which a target without installed dependencies needs.
  - Line 54 gives the model params for `review` only; `v_model` needs them too.
  - `<!-- TODO(part 2) -->` at line 59 waits on content K279 put in the pack README, which now exists.
- **Fix:** INSTALL.md says `packs` may go in either file, states K284's anchoring, adds `prepare` and `sparse` to the
  sample, names `v_model` beside `review`, links the pack README for roles and params, and drops the TODO.

### 4. ADR 0002 says the binary does not expose its embedded SDK

- **Where:** `docs/adr/0002-pack-bundles.md:8-10` and `:21-22`.
- **Citation:** K276 and K312 (a bare file bundles against the binary's embedded SDKs); `docs/architecture.md:522`.
- **Failure:** The context says an external file that imports the SDK "gets a different copy", and the third option is
  rejected because "the binary does not expose its embedded modules to external files". Since S11 the loader's
  `maestro-sdk` plugin resolves a bare file's SDK imports to the embedded bundles (`packages/cli/src/loader.ts:116-120`,
  `:213`). The ADR's reasons no longer hold, though its decision does: a pack carries its own SDK copy so its bytes
  stand alone for resume (D-30).
- **Fix:** Amend the context and the rejected option: bare files bundle against the embedded SDKs; packs keep their own
  copy because a pack's bytes, not the binary's, must fix what a resume replays.

### 5. `scripts/pack.ts` duplicates the loader's bundle and the fixture's manifest

- **Where:** `scripts/pack.ts:14` (`GLUE`), `:41-60` (`bundleOf`, `minify: { whitespace: true }`, messages joined with
  "; "), `:77` (the manifest), `:101` (`EXIT_FAILED`); `packages/cli/src/loader.ts:112` (`ENTRY`), `:180`
  (`bundlerMessage`), `:222-234` (`bundle`), `:490` (`bundled`); `packages/cli/src/fixtures/packs.ts:35-48` (`packOf`).
- **Citation:** CODING_STANDARDS (reuse a helper the codebase has); CLAUDE.md ladder rung 2; K289 (a file that does not
  bundle is a usage error, exit 2).
- **Failure:** The glue file name, the minify setting and the bundler message format are written in the loader and again
  in the script, and the manifest `{ id, version, sdk: ^SDK_VERSION, entry }` in the script and again in `packOf`. A
  change to one copy and not the other (a new glue name, a manifest field) leaves a pack the binary no longer loads. The
  same broken composition exits 2 from `maestro plan` and 1 from `just pack`.
- **Fix:** `scripts/pack.ts` builds through the loader's `bundled()` and one shared manifest writer, which `packOf` uses
  too; a bundle failure exits as the CLI's usage error.

### 6. Control-character escaping is written twice and disagrees

- **Where:** `packages/cli/src/output.ts:140` and `:155`; `packages/render-text/src/live.ts:72` and `:80-84`.
- **Citation:** CODING_STANDARDS (one concept, one definition); NFR-05 (no text moves the terminal's cursor).
- **Failure:** `closingLine` escapes every control character, newlines included, as `\n`; the live view escapes all but
  newlines and turns those into spaces. A failure reason with a newline reads `a\nb` in the closing line and `a b` in
  `watch` for the same concert, and a third caller would pick one of two rules by accident.
- **Fix:** render-text exports `safe` and `flat`, and `closingLine` uses `flat`.

### 7. Requirements still promise checked prompt templates

- **Where:** `docs/requirements.md:205` (SDK-07) and `:410` (the sssf mapping row).
- **Citation:** K245 (prompt templates cut from V1); wave 9 finding 3.
- **Failure:** The wave 9 fix removed templates from architecture 4 and port-plan S3 but left SDK-07 promising "prompt
  templating" and the mapping row "checked prompt templates", so the requirements list a feature no slice will build.
- **Fix:** SDK-07 lists the reducers only; the mapping row maps `.in` templates to typed inputs and plain prompt files.

### 8. The compose README describes key checks for `parMap` only

- **Where:** `packages/core/src/compose/README.md:72` (the `SCOPE.key` row), `:98` (its footnote) and step 3.
- **Citation:** SDK-13; wave 9 finding 8 (compose checks the literal keys of a `parFind` too).
- **Failure:** `expand.ts` now rejects duplicate literal keys in a `parFind`, but the README's row says "two items of a
  parMap instance" and the footnote's hint names the parMap's key function, so the diagnostic doc misdescribes half of
  what raises the code.
- **Fix:** Name `parFind` beside `parMap` in the row, the footnote and step 3.

### 9. Prepare, sparse and the live view's cut are described as they are not

- **Where:** `GLOSSARY.md:157` (Bind) and `:184` (Sandbox); `packages/cli/README.md:76`;
  `packages/render-text/README.md:18`; `packages/host-repo/src/lane/lanes.ts:176`.
- **Citation:** HOST-16 and H1 (prepare runs in a check's sandbox on every checked-out copy); K324 (the cut counts
  terminal cells); K347 (sparse is set on the lane's git dir); CODING_STANDARDS (a behaviour change updates its
  comment).
- **Failure:**
  - Bind says read-write "for a check" and Sandbox names "an agent or check"; `prepare` lines run in the same sandbox
    with the same binds.
  - The CLI README says "per new lane `prepare` and `sparse`"; both apply to every checked-out copy, a `read` copy and a
    re-opened extend included.
  - The render-text README says lines are cut at `columns - 1` characters; `frame` cuts at terminal cells.
  - The lanes comment says the host's git "always names the store ... never a lane's `.git`"; `checkedOutLane` at line
    381 runs `git --git-dir=${gitdir} sparse-checkout set`.
- **Fix:** Glossary entries say "a check or a prepare line"; the CLI README says "per checked-out copy"; the render-text
  README says "terminal cells"; the comment states the one exception, before any sandbox runs.

### 10. Architecture, port plan and sdk-spec lag the ported packs and the live view

- **Where:** `docs/architecture.md:71` (the Packs row); `docs/port-plan.md:44`; `docs/sdk-spec.md:533`.
- **Citation:** K269 (the live view lives in `render-text/live`); S9a (the pack is `packs/repertoire`,
  `@maestro/repertoire`); S9a and S9b (the section 15 workflows were ported and run).
- **Failure:** Architecture 3 names packs `pack-<domain>`, which no pack follows. The port plan says the live view's
  package "is placed by S10", which it was. sdk-spec 15 says its mapping "was not exercised by running anything" and to
  re-check rows when ported, though S9 ported and ran `build_then_repair`, `review` and `v_model`.
- **Fix:** The Packs row reads `packs/<id>`; the port plan names `render-text/live`; sdk-spec 15 records which rows S9
  exercised.

## Loop

| Step        | Findings | Accepted     | Changed code or design                                                                                                                | Spend[^1]              |
| ----------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Wave review | 10       | 9, 1 in part | code (shared bundler messages, one control-character escape); docs (INSTALL, ADR 0002, requirements, READMEs, GLOSSARY, architecture) | opus high, 70k, 12 min |

[^1]: Model, then tokens and wall time from each agent's notice.

[^k1]:
    `scripts/pack.ts` is a build script with its own contract (2 usage, 1 failure), as this review found each program
    keeps; only the formatting is shared.
