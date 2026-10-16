# S6c. Drop node purity, the CLI demo and wave 4 fixes: slice report

Brief: `.scratch/s6c-fixes/spec.md`. The implementer could not write files outside its fence, so the conductor wrote
this report from its hand-back.

## Done

- **No node purity (K108, ADR 0009).** Compose loads every function the IR names and calls none; `fold.ts` and its tests
  are gone. `compose/expand.ts` expands a group only when its guards are known true and its items are plain (a literal,
  or an enclosing group's item). A map with a key function expands to `{exact: n}`, counted by `bounds.ts`, its key
  function called only at perform (K110). `assert` is decided at build when its condition is plain, else at perform. The
  IR loses `pure` from its types, schema, fixtures and README changelog (still 1.0). The SDK's `pure` option and the
  worker's `pureContext` are gone. The compose README is rewritten without folding.
- **K109.** `BUILD.ambient` and `BUILD.unstable`.
- **K104.** A bare file builds from flags, its example set and its defaults; a YAML key under its stem is unclaimed, the
  hint saying to make it a pack.
- **K105.** `perform` and `wait` print one `name  value` line per result port on stdout, an artifact as its absolute
  path; `--json` gains `outputs`. A rejected concert keeps its root cause's rejection outputs (`ConcertResult` and
  `record.result()` carry them).
- **Wave 4 findings.**
  - 1: a bundle's diagnostic drops any source that is not an absolute path; the `sdk/src/diagnostic.ts` comment fixed.
  - 2: a stem that is not a pack id (`openFile`) or collides with an installed pack (`prepare`) exits 2, naming the file
    and saying to rename it.
  - 3 (K106): `Versions` and the manifest's `hosts` go; `openPack(dir, sdk)` checks the SDK range.
  - 4 (K107): `tour` takes `t`.
  - 5: `mapWorkers` in `@maestro/ir` is the one walker, under `withCurrentHashes`, `rewriteModules` and `persist`.
  - 6: core's `perform()` takes the IR the CLI pre-flighted, with an optional `resume` id; the resume refusal lives in
    core only. A fresh concert's stdlib references are rehashed before pre-flight.
  - 11: `@maestro/core` exports `messageOf` and `sha256Hex` from `src/index.ts`; `./shared` is no longer exported. The
    CLI unexports `WORKSPACE_DIR`, `PACKS` and `OptionSpec`.
  - 12: `ls` shows and filters compositions as `<pack>.<composition>`.
- **CLI README.** Caps by name, every `prune` flag, the alias `t`, the `--composition` form, result output, stem rules.
- **Passive cleanup.** Docstrings reflowed in seven files; testkit `play()` brought from complexity 12 to 10 or below by
  extracting `storage()`.

## Acceptance

| Item                                                                | Test                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A code node that prints prints once; `compose` prints nothing       | cli "a code node that prints prints once when performed, and never when composed"                |
| Compose calls no author code                                        | expand "loads each function once, and calls neither a code node's nor a key function"            |
| `--plan` shows no folded values                                     | text "listing: each node's count and expansions, then bounds"; cli "compose prints the summary…" |
| A build-time list expands exactly; a node-result size stays bounded | expand "expands a map over a plain list into keyed instances", "leaves %s a region of up to…"    |
| A code node reads `ctx.clock`                                       | testkit perform "a code node sees a fixed clock, its scratch directory and frozen host facts"    |
| Key-function duplicates compose, then fail the `map` at perform     | expand "counts a map keyed by a key function without calling it…"; testkit "a map names…"        |
| `BUILD.ambient`                                                     | ambient "%s fails with BUILD.ambient"                                                            |
| An IR with `pure` is refused                                        | ir index, the case "a code node's purity"                                                        |
| A bare file's YAML key is unclaimed whatever the target             | cli "a key under a bare file's name is unclaimed config when the target is %s"                   |
| `perform` and `wait` show outputs, with and without `--json`        | cli "a concert that settles %s prints its id first…", "prints each output on a line…", "wait…"   |
| A bundle's build error prints no base64                             | cli "a composition that cannot be built exits 2 with its diagnostics, no location inside…"       |
| A bad or colliding stem exits 2 naming the file                     | cli "usage errors > %s exits 2…"; loader "refuses a file whose name is not a pack id…"           |
| A manifest naming `hosts` fails its schema                          | loader "refuses %s, naming the pack", the case "a manifest naming hosts"                         |
| `ls --composition <pack>.<composition>` filters                     | cli "ls filters by status, composition, workspace and limit…"                                    |

The implementer confirmed the "prints once" and stdlib-rehash tests fail against the old code.

## Raised by the implementer, triaged

| #   | Call                                                       | Verdict                                                        |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | The plan's `Expansion` gains `{exact: n}`                  | Derived: K110 keeps a build-time list's count exact            |
| 2   | Compose no longer calls a host's `environment()`           | Derived: it fed folded nodes' context only (ADR 0009)          |
| 3   | Artifacts print as absolute paths                          | Derived: K105 "as its path"; a path the user can open anywhere |
| 4   | `wait` prints status, then outputs, on stdout              | Derived: K105, status kept as before                           |
| 5   | Core's refusal messages, naming no CLI command             | Derived: finding 6, core owns the refusal                      |
| 6   | `ls --composition` takes only `<pack>.<composition>`       | Derived: finding 12, the form `perform` takes (D-29)           |
| 7   | `ls --json` keeps `pack` and `composition` as fields       | Derived: K99, field names follow the record's columns          |
| 8   | A fresh concert's stdlib references rehashed at pre-flight | Derived: ADR 0008, the engine's stdlib runs                    |
| 9   | `replaceAt` in `@maestro/ir`; core exports `concertDirs`   | Derived: finding 5, one walker                                 |
| 10  | The unclaimed hint for a bare file                         | Derived: K104                                                  |

## Derived, not ruled

| Decision                                                              | Source                   | Strength       | Reversal | Landed       |
| --------------------------------------------------------------------- | ------------------------ | -------------- | -------- | ------------ |
| A guarded group expands only when an inner port makes its guard true  | architecture 7, ADR 0009 | by consistency | cheap    | `expand.ts`  |
| A bare file's config is the composed config, with no layer it claims  | K104                     | decided        | cheap    | `prepare.ts` |
| The stem pattern is checked in `openFile`, the collision in `prepare` | Finding 2                | by consistency | cheap    | `loader.ts`  |
| `openPack(dir, sdk)`                                                  | K106                     | by consistency | cheap    | `loader.ts`  |
| A duplicate cap-stop compose test dropped                             | CLAUDE.md "Tests"        | decided        | cheap    | compose test |

## Review triage

| #   | Finding                                                                  | Verdict  | Reason                                                |
| --- | ------------------------------------------------------------------------ | -------- | ----------------------------------------------------- |
| 1   | Resume refusal runs after pre-flight and lost the commands to type       | Accepted | CODING_STANDARDS user-facing output; finding 6        |
| 2   | `perform()` throws synchronously for a refused resume                    | Rejected | Documented in `@throws`; core's API is reviewed at S7 |
| 3   | `nodes.ts` says key functions are checked at compose                     | Accepted | K110; docstrings kept in step                         |
| 4   | The bad-stem error names the absolute path, not the file as typed        | Accepted | clig.dev, name the thing as typed                     |
| 5   | A one-line string lets `\r` and U+2028 through                           | Accepted | K105                                                  |
| 6   | `ParamFlags` and `Params` exported with no other user                    | Accepted | Finding 11                                            |
| 7   | Core keeps `withCurrentHashes`; the walker forced sync callers async     | Accepted | NFR-09; finding 6                                     |
| 8   | No test for the `t` alias or the bounds `exact` branch; a duplicate test | Accepted | Tests rule                                            |

## Loop

| Step      | Findings | Accepted | Changed code or design                        | Spend[^1]        |
| --------- | -------- | -------- | --------------------------------------------- | ---------------- |
| Implement | n/a      | n/a      | every deliverable; 10 calls raised, 5 derived | 100k tok, 33 min |
| Gate      | 0        | n/a      | Prettier on the conductor's handoff only      | conductor        |
| Review    | 8        | 7        | code (findings 1, 3 to 8)                     | 202k tok, 8 min  |
| Fix 1     | n/a      | n/a      | findings 1, 3 to 8; one synchronous walker    | 164k tok, 5 min  |

[^1]: Tokens and wall time from each agent's completion notice.

## `just check`

After fix round 1, run by the conductor: Biome, Prettier and `tsc` are clean, and `bun test` gives 777 pass and 0 fail
across 36 files.
