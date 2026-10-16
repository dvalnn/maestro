# S6. Config and CLI

Status: needs-triage

Slice:        S6 Config and CLI (contract-setting: code references, the config layout, the CLI's JSON output and exit
              codes)
Goal:         Load packs, composition files and IR from disk, compose layered config with provenance, and drive
              compose and perform from the `maestro` CLI with JSON output and documented exit codes (CFG-01 to
              CFG-06, CLI-01 to CLI-04, CLI-06, CLI-07, AC-6).
Read:         requirements.md (CFG-01 to CFG-06, CLI-01 to CLI-07, D-12 to D-17, D-19, D-24, D-26, D-27, D-29,
              D-30, NFR-02, NFR-03, NFR-05, AC-6 to AC-8), architecture.md 3, 4, 7 (Cache, Resume, Cancellation),
              8, 10, 13, 16, sdk-spec.md 2, 8 to 10, 12, 13.3, ADRs 0002, 0007, 0008, packages/ir/README.md (worker
              references, `codeHash`), packages/core/src/compose/README.md, packages/core/src/{host.ts,perform/},
              packages/sdk/src/{composition,graph}.ts, packages/testkit, backlog 02, 03, 08, 09,
              docs/reports/s0/spike-3.md, morning-calls K18, K32 to K48, CODING_STANDARDS.md
Package:      packages/cli/ (new) and packages/core/src/config/ (new), with narrow changes in
              packages/core/src/compose/checks.ts (pack claims), packages/core/src/perform/record.ts (prune and the
              resume base), packages/core/src/host.ts (optional seams), packages/sdk/src/composition.ts (use-site
              layers) and packages/testkit/.
Deliverables:
  1. Config files (CFG-02, CFG-04, CORE-18, D-07): user, workspace and profile YAML located per K53 and parsed with
     `Bun.YAML`, a syntax error naming the file and line. Layers merge lowest first, default, user, workspace,
     profile, flag, by the rule K54 gives, and every value keeps the layer and file it came from.
  2. Core config (CFG-01, D-23, D-26, K41, K45): a closed schema of the top-level keys core owns, handed to compose
     as `ComposeInput.core`: `cache` (`on` or `off`, to S5's perform option), the concurrency cap
     (`PerformOptions.concurrency`) and caps by name (`ComposeInput.caps`). Event sinks and pre-flight strictness
     per K55, where the record, concert areas and compose scratch live per K56. No timeout key (K41).
  3. Claims (CFG-02, CFG-05, D-17, D-24): an installed pack claims its id, each of its compositions a key under it,
     and each composition's params the keys under that. Compose's `checkConfig` counts installed packs as
     claimants. An unclaimed key at any of these levels fails with a did-you-mean hint
     through the existing `closest` in `compose/checks.ts`. Where packs are listed per K57, any other namespace a
     pack claims per K58.
  4. Param values (D-16, D-17, D-19, CFG-03, CFG-04, SDK-05): a root composition's params resolve default, YAML
     layers, then flags, and are checked before build, the example set placed per K59. A subcomposition's YAML
     values reach `use` through the build context under the namespace K60 names, and the use
     site still wins.
  5. Packs (D-30, PACK-01, PACK-02, ADR 0002): a `maestro-pack.json` schema (id, version, entry, semver ranges on
     the SDK and hosts it uses, checked at load), an entry that cannot leave the pack directory, and import errors
     wrapped with the pack's id (spike 3 follow-ups). What the entry exports per K61, URL packs per K62.
  6. The loader (ADR 0008, backlog 08, K18): `resolveCode` for the build context and `loadCode` for compose and
     perform, for a pack bundle (K63), a bare composition file (K64) and an IR file (`module` relative to the IR
     file's directory, its bytes checked against `codeHash` before any node starts, ruling W1-rel). Lookup by
     identity walks object exports one level down (backlog 08 spike), and a function under two names follows K65.
     `maestro:stdlib` maps to `@maestro/sdk/stdlib`, and an export it lacks is a compose error.
  7. `codeHash` (ADR 0008, CORE-09, K42): each loader's form, recorded in ADR 0008 as it asks, and the current-hash
     function S5's resume takes, so a changed module reruns the nodes K66 rules affected, and their dependents.
  8. The `cli` package (CLI-07, D-14, D-29, AC-7): a `maestro` bin entry and the verbs `compose`, `perform`, `ls`,
     `wait`, `kill`, `config` and `prune`, with the aliases `c`, `p`, `w`, `k` and `cfg` shown in help, parsed with
     `node:util` `parseArgs`. Hosts are injected, the testkit's fake host in tests. A composition argument ending
     `.ts`, `.js` or `.json` is a file (D-29), and anything else names a pack's composition as K67 gives.
  9. Flags (D-17, SDK-01, CLI-01, sdk-spec 9): flags derived from the IR's param schema, validated before build. A
     missing required param or a schema violation is a usage error naming the flag and the fix (CLI-06).
     Spelling and non-scalar values per K68, params with an `x-maestro-type` per K69.
  10. `compose` (D-13, D-19, D-29, CLI-01, CORE-07): build or load, then pre-flight, starting no node instance. With
      no flags it uses the first example set. It prints diagnostics and the one-line `summary` by default,
      `listing` with `--plan`, `render` with `--graph`, the IR with `--out <file>`, and the plan or the diagnostics
      with `--json`. Params of an already built IR per K70.
  11. `perform` (CLI-02, NFR-02, D-26, CORE-09, K42 to K44): compose first, an error diagnostic stopping it before
      any node instance starts, never an example set, and the concert id on stdout, in the foreground or not per
      K71. `--resume <concert id>` runs the stored IR with the loader's current hashes, refuses a live concert and
      finds its modules per K72.
  12. `ls`, `wait` and `kill` (CLI-03, CORE-11, HOST-10, architecture 10): `ls` over the record's queries with the
      filters K73 gives. `wait <concert>` takes `--timeout <duration>` and exits with the outcome's code or the
      timeout's. `kill` cancels through the kinds' cancel hooks by the means K74 gives, and the record stays
      consistent.
  13. `config` (CFG-06, CORE-18): the composed config for a composition, each value with its layer and file,
      validated as compose validates it. Secrets per K75.
  14. `prune` (CLI-03, D-27, K45): removes what K76 says, the concerts' cache entries included, through a new
      record query, and their host resources through the seam K77 gives. No alias (D-14).
  15. Output and errors (CLI-04, CLI-06, CORE-17, backlogs 02 and 03): `--json` on every command. One diagnostic
      renderer to stderr: the source location when known, the code and message, then the hint. Exit codes per K78.
      Any other error is one or two lines naming what failed and what to do, with no stack unless `--debug`.
  16. Docs (NFR-05, CLI-04): `packages/cli/README.md` with the verbs, aliases, config files and exit codes, and the
      note that a pack runs operator-trusted code.
Acceptance:   With the fake host and fixture packs: AC-6, each of `compose`, `perform`, `ls`, `wait`, `kill` and
              `config` by verb and by alias, with `--json` and the documented exit code for accepted, rejected,
              failed, usage error and wait timeout; precedence across default, user, workspace, profile and flag,
              and each value's provenance; a typo'd key at the top level, under a pack, under a composition and
              among its params gives a did-you-mean diagnostic; a compose error starts no concert (NFR-02); a
              hand-written IR file performs through the CLI with no SDK import (AC-8), and one whose module bytes
              differ from its `codeHash` fails before any node starts; a missing stdlib export is a compose error;
              a concert killed from another process settles `failed`, and `perform --resume` finishes it without
              repeating an `ok` node; resuming a live concert is refused; `prune` removes a settled concert's
              record, artifacts, cache entries and fake host resources, and refuses a running one; `ls` cold start
              measured (NFR-03); no domain words in `cli` (CORE-12); `just check` output.
Out of scope: `watch` (S10, CLI-05); wiring the coding-agent host and implementing the lane ref param type (S8e);
              the compiled binary and releases (S11, AC-7 beyond the bin entry); pack build tooling and the real
              pack (S9); derived metadata (S2-Q1); `tpl` (backlog 07); timeouts beyond a code node's own (K41,
              backlog 11); record migrations (K33); a secret param type (D-33); out-of-process workers.
Constraints:  clean break, no domain words in `cli` (port plan rule 3), lean (NFR-09), no guessing, no new
              dependencies (`Bun.YAML`, `node:util` and the installed `ajv` cover parsing). Parse config, manifests,
              flags and IR at the boundary (CODING_STANDARDS). The record stores no config (K38), and param values
              reach it only inside the IR (wave review K51). Host interface changes follow wave review K49 as
              ruled. Runs after S5 is committed, with K47 and K48 as ruled for it.
Open Qs:      K53. Where are the config files, and what is a workspace (GLOSSARY has no entry)? A: user
              `$XDG_CONFIG_HOME/maestro/config.yaml`, workspace `.maestro/config.yaml` in the nearest ancestor of
              the cwd holding `.maestro/`, profile `.maestro/profiles/<name>.yaml` chosen by `--profile`
              (recommended). B: as A, with the workspace at the git root. C: one `--config <file>` per layer.
              K54. How do layers merge? A: maps merge by key, and any other value, lists included, is replaced whole
              by the higher layer (recommended). B: lists append across layers.
              K55. CFG-01 names event sinks and pre-flight strictness, and nothing consumes a sink. A: no sink key
              in V1, the record being the one source (NFR-07), and `strict: true` turning compose warnings into
              errors (recommended). B: a sink key naming a JSON-lines file perform appends events to. C: neither.
              K56. Where do the record store, concert areas and compose's scratch live? A: under one data root key,
              default `.maestro/` in the workspace, which also closes backlog 09 (recommended). B: one key each.
              C: A, plus architecture 16's low-disk warning with a threshold key.
              K57. Where are packs and hosts listed? A: a `packs` list of paths under a key the CLI owns, and every
              host the binary embeds is installed, with no key (recommended). B: `packs` and `hosts` in core
              config, widening CFG-01.
              K58. Can a pack claim namespaces beyond its compositions' params (S2-Q2)? A: not in V1, so the SDK
              gets no claim API and leaves the IR's `config` unset (recommended). B: the manifest declares
              namespace schemas. C: an SDK claim API that emits the IR's `config`.
              K59. Where does the example set sit among the layers (D-19)? A: in place of the flags, over every YAML
              layer, a given flag overriding its own key (recommended). B: just over the defaults, under the YAML
              layers. C: used only when no flag at all is given.
              K60. Whose YAML namespace sets a subcomposition's params, one from another pack included (backlog
              08)? A: its own, `<its pack>.<its id>`, so one entry tunes it wherever it is used (recommended). B:
              the using pack's, `<using pack>.<its id>`. C: none; only the use site and the default.
              K61. What does a pack's entry export, given its own SDK copy builds the IR (ADR 0002)? A: one
              SDK-made object listing its compositions (name, doc, params, examples) with a `build(name, params,
              context)` bound to that copy (recommended). B: the compositions and the SDK's `build` as two exports.
              K62. D-30 lists packs by path or URL. A: paths only in V1, as a URL needs an install step (DIST-04)
              (recommended). B: a URL is fetched and unpacked into the data root on first use.
              K63. What is a pack code node's `module` relative to, and does IR saved by `compose --out` run as an
              IR file (W1-rel)? A: the directory of the pack the IR's `composition.pack` names, found through the
              pack list, and `--out` rewrites each `module` relative to the output file (recommended). B: as A,
              with `--out` IR for inspection only. C: `<pack id>:<entry>`, a new `module` format (W2 option A).
              K64. Bare `.ts` and `.js` composition files (W1, D-29)? A: the file is its own entry, `module` is
              relative to its directory, and the loader bundles it in memory with `Bun.build` so `codeHash` covers
              its imports; mapping its `@maestro/sdk` import inside the compiled binary is S11's to prove
              (recommended). B: no bundling, and `codeHash` hashes every file under its directory. C: drop bare
              files from V1, amending D-29.
              K65. One function reachable under two names, such as `found` and `b.score` (backlog 08)? A: the first
              name in sorted order, top-level names before nested ones (recommended). B: a build error naming both.
              K66. A pack's `codeHash` hashes its whole bundle, so any change reruns all its code nodes on resume
              and misses their cache. Does that meet CORE-09's "exactly the affected nodes"? A: yes, read as "nodes
              whose `codeHash` or inputs changed", shown per node on hand-written IR (recommended). B: no; the pack
              build writes a per-export hash map from the bundler's metafile into the manifest.
              K67. How does the CLI name a pack's composition (CLI-01)? A: `<pack>.<composition>`, as the YAML keys
              nest (recommended). B: `<pack>/<composition>`. C: B, or a bare `<composition>` when exactly one
              installed pack has it.
              K68. Flag spelling and non-scalar params (S2-Q3)? A: `--<param>` exactly as declared, a list repeats
              the flag, an object takes JSON text, and no new schema keyword (recommended). B: kebab-case flags.
              C: an `x-maestro-flag` keyword for names and short flags.
              K69. Who turns a flag into a param with an `x-maestro-type`, such as the lane ref (HOST-13, sdk-spec
              12.6)? A: an optional `Host` member added now, beside wave review K49's host checks and before S7
              freezes the interface, tested with a fake type; an artifact-typed param is a usage error until a
              composition needs one (recommended). B: the seam waits for S8e, and S6 refuses every marked param.
              C: A, with an artifact param's path hashed into an `ArtifactRef` that has no producer.
              K70. An already built IR, a hand-written file or a resumed concert's, carries its build's param values
              (wave review K51). A: it takes no param flags, a given one being a usage error, pre-flight checks the
              recorded values, and resume re-runs pre-flight under the current config and hosts (recommended). B:
              flags are taken and must equal the recorded values. C: as A, but resume skips pre-flight.
              K71. Does `perform` stay in the foreground? A: it prints the id at once, stays until the concert
              settles and exits with its outcome's code; Ctrl-C cancels it (recommended). B: it starts a detached
              process, prints the id and exits 0, leaving the outcome to `wait`. C: A, with `--detach` for B.
              K72. The record keeps the IR (K32), whose header names its pack, but not the directory an IR file or
              bare file resolved its modules against. A: the concert row stores that directory, and resume fails,
              naming it, when it is gone (recommended). B: `--resume` takes the source again, amending D-29. C:
              the stored IR holds absolute module paths.
              K73. What can `ls` filter on (CLI 6.6)? A: concerts newest first with `--status`, `--composition` and
              `--limit` (default 20), the record's own filters, and `ls <concert>` for its node instances
              (recommended). B: A, plus `--since <duration>`. C: no filters; pipe `--json` through `jq`.
              K74. How does `kill` stop a concert another process performs? A: SIGTERM to the recorded pid once
              `/proc/<pid>/cmdline` shows it is maestro's, so K34's pid reuse never signals a stranger, and that
              process's handler cancels the concert (recommended). B: a cancel request in the record that perform
              polls.
              K75. `config` prints values that may be secrets (CFG-03, NFR-05). A: as they are, since it is the
              operator's own stdout and not a log (recommended). B: mask values whose schema marks `writeOnly`.
              K76. What does `prune` remove, and when? A: `prune <concert>...` or `prune --before <duration>`, for
              settled concerts only: record rows and events, artifact area, cache entries (K45) and host
              resources, confirming on a TTY with `--yes` to skip (recommended). B: with no argument, every
              settled concert. C: all but the newest N.
              K77. How do `prune` and `ls` reach host resources such as lanes (D-27, HOST-13) with no domain words
              in `cli`? A: two optional `Host` members, `release(concert)` and `usage(concert)` in bytes, tested
              with the fake host and implemented for lanes in S8e, beside wave review K49 (recommended). B: only
              `release` now, disk use in S8e.
              K78. Exit code values (CLI-04, backlog 02)? A: 0 accepted, 1 failed and internal errors, 2 usage
              error including compose diagnostics (architecture 16), 3 rejected, 124 wait timeout as GNU `timeout`
              (recommended). B: as A, with sysexits 64 for usage and 65 for compose diagnostics. C: 0, 1 rejected,
              2 failed, 64 usage, 75 timeout.
Report:       docs/reports/s6/slice-report.md with the Loop table.

## Proposed split

S6 is the plan's L, and it now also carries the loader (backlog 08, K18), pack loading, a channel into the SDK
and seven verbs. Split at the loader: S6a sets the contracts S6b and S9 build on and can start beside S5, which
only needs the current-hash function's type.

Slice:        S6a Loader and config (contract-setting: code references and the config layout)
Goal:         Load packs, composition files and IR from disk and compose layered config with provenance (CFG-01 to
              CFG-05, CORE-18, ADR 0008).
Package:      packages/core/src/config/ (new), packages/cli/ (new: the loader and config wiring, no verbs), with
              narrow changes in packages/core/src/compose/checks.ts and packages/sdk/src/composition.ts.
Deliverables: 1 to 7 above: config files, core config, claims, param values, packs, the loader, `codeHash`.
Acceptance:   Precedence and provenance across every layer; did-you-mean at each claim level; a fixture pack, a
              bare file and an IR file each build or load and fold through compose; a module whose bytes differ
              from its `codeHash` fails; a missing stdlib export is a compose error; the current-hash function
              reruns a changed node on S5's resume of a fixture pack, per K66; `just check` output.
Out of scope: deliverables 8 to 16; as above otherwise.
Constraints:  as above. Runs beside S5 once S5's current-hash function type is fixed.
Open Qs:      K53 to K66.
Report:       docs/reports/s6a/slice-report.md with the Loop table.

Slice:        S6b CLI verbs
Goal:         Drive compose and perform from the `maestro` CLI with JSON output and documented exit codes (CFG-06,
              CLI-01 to CLI-04, CLI-06, CLI-07, AC-6).
Package:      packages/cli/, with narrow changes in packages/core/src/perform/record.ts (prune, resume base),
              packages/core/src/host.ts (optional seams) and packages/testkit/.
Deliverables: 8 to 16 above: the package and verbs, flags, `compose`, `perform`, `ls`, `wait`, `kill`, `config`,
              `prune`, output and errors, docs.
Acceptance:   the S6 acceptance above, less what S6a showed.
Out of scope: as above.
Constraints:  as above. Runs after S6a and S5 are committed.
Open Qs:      K67 to K78.
Report:       docs/reports/s6b/slice-report.md with the Loop table.
