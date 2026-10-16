# S6. Config and CLI

Status: ready-for-agent

Slice:        S6 Config and CLI (contract-setting: code references, the config layout, the CLI's JSON output and exit
              codes)
Goal:         Load packs, composition files and IR from disk, compose layered config with provenance, and drive
              compose and perform from the `maestro` CLI with JSON output and documented exit codes (CFG-01 to
              CFG-06, CLI-01 to CLI-04, CLI-06, CLI-07, AC-6).
Read:         requirements.md (CFG-01 to CFG-06, CLI-01 to CLI-07, D-12 to D-17, D-19, D-24, D-26, D-27, D-29,
              D-30, NFR-02, NFR-03, NFR-05, AC-6 to AC-8), architecture.md 3, 4, 7 (Resume, Cancellation),
              8, 10, 13, 16, sdk-spec.md 2, 8 to 10, 12, 13.3, ADRs 0002, 0007, 0008, packages/ir/README.md (worker
              references, `codeHash`), packages/core/src/compose/README.md, packages/core/src/{host.ts,perform/},
              packages/sdk/src/{composition,graph}.ts, packages/testkit, backlog 02, 03, 08, 09,
              docs/reports/s0/spike-3.md, morning-calls K18, K32 to K48, CODING_STANDARDS.md
Package:      packages/cli/ (new) and packages/core/src/config/ (new), with narrow changes in
              packages/core/src/compose/checks.ts (pack claims), packages/core/src/perform/record.ts (concert row
              fields, prune), packages/core/src/host.ts (optional seams), packages/sdk/src/composition.ts (use-site
              layers, `describe`, the glue generator), packages/ir (the `config` block's removal) and
              packages/testkit/.
Deliverables:
  1. Config files (CFG-02, CFG-04, CORE-18, D-07): user `$XDG_CONFIG_HOME/maestro/config.yaml`, workspace
     `.maestro/config.yaml` in the nearest ancestor of the cwd holding `.maestro/`, profile
     `.maestro/profiles/<name>.yaml` chosen by `--profile`. Parsed with the `yaml` package (the one new dependency):
     `!replace` makes a mapping replace what is beneath it, `!append` follows the list beneath, `!delete` removes a
     key a lower layer set, and any other tag, or a tag with nothing to apply to, is an error naming the file and line.
     Layers merge lowest first, default, user, workspace, profile, flag: maps by key, any other value replaced whole.
     Every value keeps the layer, file and line it came from. A relative path is relative to the directory of the file
     that sets it.
  2. Core config (CFG-01, D-23, D-26): a closed schema of the concurrency cap (`PerformOptions.concurrency`), caps by
     name (`ComposeInput.caps`), the data root, and `workspace`. The data root holds the record store, concert areas,
     node scratch and lane stores; it defaults to `$XDG_DATA_HOME/maestro` (`~/.local/share/maestro` when unset), and a
     workspace opts into a local one by setting the key. `workspace` names the workspace, defaulting to the basename of
     its directory, empty outside any. No event sinks, `strict` or timeout key.
  3. Claims (CFG-02, CFG-05, D-17, D-24): `packs` (below) is a top-level key the CLI owns. An installed pack claims its
     id, each of its compositions a key under it, and each composition's params the keys under that; packs claim no
     other namespace. Compose's `checkConfig` counts installed packs as claimants, and an unclaimed key at any level
     fails with a did-you-mean hint through `closest`. The IR's top-level `config` block goes: `types.ts`,
     `ir.schema.json`, the README and the fixtures (still IR 1.0, the changelog's 1.0 entry noting it).
  4. Param values (D-16, D-17, D-19, CFG-03, CFG-04, SDK-05): a root composition's params resolve default, YAML
     layers, the example set (`compose` only, standing over every YAML layer, a given flag overriding its own key),
     then flags, and are checked before build. A subcomposition's params live under the `<pack>.<id>` of the bundle that holds it, and reach `use` through the build context; the use site still wins. A param whose schema carries an
     `x-maestro-type` is read through its owning host's `param` (deliverable 17), from a flag and from YAML alike; a
     core artifact type as a param is a usage error naming the flag.
  5. Packs (D-30, PACK-01, PACK-02, ADR 0002): listed by path in `packs`, no URL. A `maestro-pack.json` schema (id,
     version, entry, semver ranges on the SDK and hosts it uses, checked at load), an entry that cannot leave the pack
     directory, and import errors wrapped with the pack's id (spike 3 follow-ups). Authors export compositions plainly;
     whatever bundles them adds an entry that exports the bundle's own SDK `describe()` (each composition's name, doc,
     params as JSON Schema, examples) and `build(name, params, context)` returning IR JSON, so the build runs through
     that copy. The SDK gains `describe`; one glue generator serves the loader's bare files and S9's pack build, and
     the fixture packs are built with it.
  6. The loader (ADR 0008, backlog 08, K18): `resolveCode` for the build context and `loadCode` for compose and
     perform, for a pack bundle (`module` relative to its pack's directory, found through `packs`), a bare composition
     file (its own entry, bundled in memory with `Bun.build` so `codeHash` covers its imports; whether its SDK import
     maps to an embedded copy in the compiled binary is S11's to prove) and an IR file (`module` relative to the IR
     file's directory, its bytes checked against `codeHash` before any node starts). `compose --out` rewrites each
     `module` relative to the output file, so saved IR runs as an IR file. Lookup by identity walks object exports one
     level down (backlog 08 spike); a function reachable under two names is a build error naming both. `maestro:stdlib`
     maps to `@maestro/sdk/stdlib`, and an export it lacks is a compose error.
  7. `codeHash` (ADR 0008, CORE-09): each loader's form, recorded in ADR 0008 as it asks, and the async `CodeHash`
     S5's perform takes. A pack hashes its whole bundle, so a change reruns its code nodes, and the dependents whose
     inputs changed (CORE-09 read as "nodes whose `codeHash` or inputs changed").
  8. The `cli` package (CLI-07, D-14, D-29, AC-7): a `maestro` bin entry and the verbs `compose`, `perform`, `ls`,
     `wait`, `kill`, `config`, `prune` and `tour`, with the aliases `c`, `p`, `w`, `k` and `cfg` shown in help, parsed
     with `node:util` `parseArgs`. Hosts are injected, the testkit's fake host in tests. A composition argument ending
     `.ts`, `.js` or `.json` is a file (D-29); anything else is `<pack>.<composition>`. Every command targets exactly
     one record store, the one the data root resolves to.
  9. Flags (D-17, SDK-01, CLI-01, sdk-spec 9): a param's flag is its declared name in kebab-case (`maxRepairs` and
     `max_repairs` are `--max-repairs`); YAML keys stay as declared. A list repeats the flag, an object takes JSON
     text, and there are no custom names or short flags. Two params on one flag, or a param flag clashing with a CLI
     flag, is an error naming both. A missing required param or a schema violation is a usage error naming the flag
     and the fix (CLI-06). An already built IR takes no param flags; a given one is a usage error.
  10. `compose` (D-13, D-19, D-29, CLI-01, CORE-07): build or load, then pre-flight, starting no node instance. With
      no flags it uses the first example set. It prints diagnostics and the one-line `summary` by default, `listing`
      with `--plan`, `render` with `--graph`, the IR with `--out <file>`, and the plan or the diagnostics with
      `--json`.
  11. `perform` (CLI-02, NFR-02, D-26, CORE-09): compose first, an error diagnostic stopping it before any node
      instance starts, never an example set. It prints the concert id at once, stays in the foreground until the
      concert settles and exits with its outcome's code; Ctrl-C cancels it. `--tour <slug>` (or `MAESTRO_TOUR`) and
      `--title "<text>"` set the concert's tour and title. `--resume <concert id>` re-runs pre-flight under the current
      config and hosts, then runs the stored IR with the loader's current hashes; it refuses a live concert and one that
      finished `ok`, keeps the tour and title, and finds its modules through the directory the concert row stores,
      failing with that directory named when it is gone.
  12. `ls`, `wait` and `kill` (CLI-03, CORE-11, HOST-10, architecture 10): `ls` lists concerts newest first with id,
      title, tour, workspace, composition, outcome and disk use (artifact area plus each host's `usage`), filtered by
      `--status`, `--composition`, `--tour`, `--workspace` and `--limit` (default 20); `ls <concert>` lists its node
      instances, rows a resume left marked stale. `wait <concert>` takes `--timeout <duration>` and exits with the
      outcome's code or the timeout's. `kill` sends SIGTERM to the recorded pid once `/proc/<pid>/cmdline` shows it is
      maestro's, and that process cancels the concert through the kinds' cancel hooks; resume's live-concert refusal
      uses the same check. The record stays consistent.
  13. `config` (CFG-06, CORE-18): the composed config for a composition, each value with its layer, file and line,
      validated as compose validates it. Values print as they are (secret handling is backlog 13).
  14. `prune` (CLI-03, D-27): `prune <concert>...` or `prune --before <duration>`, narrowed by `--tour` and
      `--workspace`, for settled concerts only. Each host's `release` runs first, then the record rows, events and
      artifact area go; a host failure keeps the concert and names the host. It confirms on a TTY, showing the count
      and disk use, and `--yes` skips that. No alias (D-14).
  15. Output and errors (CLI-04, CLI-06, CORE-17, backlogs 02 and 03): `--json` on every command. One diagnostic
      renderer to stderr: the source location when known, the code and message, then the hint. Exit codes: 0
      accepted, 1 failed and internal errors, 2 usage error including compose diagnostics, 3 rejected, 124 wait
      timeout. Any other error is one or two lines naming what failed and what to do, with no stack unless `--debug`.
  16. `tour`: a tour groups thematically related concerts, one per concert. `maestro tour <slug> <concert>...` puts
      concerts on it and `--clear` takes them off. A slug is lowercase kebab of at most 64 characters, refused, never
      truncated.
  17. Host seams (architecture 6): optional `param(type, text)` returning `{ value }` or `{ diagnostics }` (parsing
      only; existence stays in the host's `validate`), `release(concert)` and `usage(concert)` in bytes, each tested
      with the fake host. The record's concert row gains `workspace`, `tour`, `title` and the module directory.
  18. Docs (NFR-05, CLI-04): `packages/cli/README.md` with the verbs, aliases, config files, merge tags and exit codes,
      and the note that a pack runs operator-trusted code.
Acceptance:   With the fake host and fixture packs: AC-6; each verb by name and by alias, with `--json` and the
              documented exit code for accepted, rejected, failed, usage error and wait timeout; precedence across
              default, user, workspace, profile, example set and flag, each value's provenance with file and line; each
              merge tag, and an unknown tag refused with file and line; a typo'd key at the top level, under a pack,
              under a composition and among its params gives a did-you-mean diagnostic; a compose error starts no
              concert (NFR-02); a hand-written IR file performs through the CLI with no SDK import (AC-8), and one
              whose module bytes differ from its `codeHash` fails before any node starts; `compose --out` IR performs;
              a missing stdlib export is a compose error; a function under two names fails naming both; a fake-host
              typed param read from a flag and from YAML, and a malformed one refused naming the flag; a concert
              killed from another process settles `failed`, and `perform --resume` finishes it without repeating an
              `ok` node; resuming a live or `ok` concert is refused; tours and titles set, changed, listed and
              filtered; `prune` removes a settled concert's record, artifacts and fake host resources, and refuses a
              running one; `ls` shows disk use; `ls` cold start measured (NFR-03); no domain words in `cli`
              (CORE-12); `just check` output.
Out of scope: `watch` (S10, CLI-05); wiring the coding-agent host and implementing its `param`, `release` and `usage`
              (S8e); the compiled binary and releases (S11, AC-7 beyond the bin entry); pack build tooling beyond the
              shared glue generator, and the real pack (S9); derived metadata (S2-Q1); `tpl` (backlog 07); timeouts
              beyond a code node's own (backlog 11); record migrations; a secret param type (D-33), secret masking
              (backlog 13); listing another store (backlog 14); pruning by outcome (backlog 15); event sinks (backlog
              16); out-of-process workers.
Constraints:  clean break, no domain words in `cli` (port plan rule 3), lean (NFR-09). One new dependency, `yaml`;
              `node:util` and the installed `ajv` cover the rest. Parse config, manifests, flags and IR at the
              boundary (CODING_STANDARDS). The record stores no config and no params; core and the IR take no params.
              Builds on S5's resume. Follow "Owner calls" in docs/agents/implementation-loop.md.
Open Qs:      none. K53 to K92 are ruled in .scratch/wave3/morning-calls.md. Keep the TODO on `Host` in
              `packages/core/src/host.ts`, which points at backlog 17.
Derived:      not ruled by the owner, listed for a glance:
              - A bare file is its own entry, bundled in memory so `codeHash` covers its imports (D-29, ADR 0008).
              - Resume re-runs pre-flight under the current config and hosts (NFR-02, CLI-02).
              - The concert row stores the module directory, and resume fails naming it when it is gone (D-29: resume
                takes only an id).
              - `kill` signals the recorded pid after a `/proc` check, shared with resume's refusal (D-25, Linux).
              - Node scratch and lane stores sit under the data root, so a settled output moves rather than copies.
Report:       .scratch/s6-config-cli/s6-report.md with the Loop table and a "Derived, not ruled" table.

## Proposed split

S6 is the plan's L, and it now also carries the loader (backlog 08, K18), pack loading, a channel into the SDK
and eight verbs. Split at the loader: S6a sets the contracts S6b and S9 build on.

Slice:        S6a Loader and config (contract-setting: code references and the config layout)
Goal:         Load packs, composition files and IR from disk and compose layered config with provenance (CFG-01 to
              CFG-05, CORE-18, ADR 0008).
Package:      packages/core/src/config/ (new), packages/cli/ (new: the loader and config wiring, no verbs), with
              narrow changes in packages/core/src/compose/checks.ts and packages/sdk/src/composition.ts.
Deliverables: 1 to 7 above, and `param` from 17: config files, core config, claims, param values, packs, the loader,
              `codeHash`.
Acceptance:   Precedence and provenance across every layer; the merge tags; did-you-mean at each claim level; a
              fixture pack, a bare file and an IR file each build or load and fold through compose; a module whose
              bytes differ from its `codeHash` fails; a missing stdlib export is a compose error; a typed param read
              through the fake host; the current-hash function reruns a changed node on S5's resume of a fixture
              pack; `just check` output.
Out of scope: deliverables 8 to 18 but `param`; as above otherwise.
Constraints:  as above.
Open Qs:      none.
Report:       .scratch/s6-config-cli/s6a-report.md with the Loop table.

Slice:        S6b CLI verbs
Goal:         Drive compose and perform from the `maestro` CLI with JSON output and documented exit codes (CFG-06,
              CLI-01 to CLI-04, CLI-06, CLI-07, AC-6).
Package:      packages/cli/, with narrow changes in packages/core/src/perform/record.ts (prune, resume base),
              packages/core/src/host.ts (optional seams) and packages/testkit/.
Deliverables: 8 to 18 above: the package and verbs, flags, `compose`, `perform`, `ls`, `wait`, `kill`, `config`,
              `prune`, output and errors, `tour`, `release` and `usage`, docs.
Acceptance:   the S6 acceptance above, less what S6a showed.
Out of scope: as above.
Constraints:  as above. Runs after S6a is committed.
Open Qs:      none.
Report:       .scratch/s6-config-cli/s6b-report.md with the Loop table.
