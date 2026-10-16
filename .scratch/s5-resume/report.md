# S5. Resume: slice report

Brief: `.scratch/s5-resume/spec.md`.

## Done

- **Resume key** (`perform/resume.ts:resumeKey`): a hash of the node as the IR holds it (its own `config` included), the
  current `codeHash`, and its inputs with each artifact replaced by its content hash, through `canonicalJson`, now one
  copy in `@maestro/ir`.
- **Current hashes** (`withCurrentHashes`) apply to every concert, fresh or resumed, before the stored IR is written and
  before any key: code nodes and `map` key functions. `PerformBase.codeHash` is an async function.
- **Resume** (`PerformOptions.resume`, a concert id): it keeps the id and runs the stored IR.
  - Refusals: a live concert, naming the holding process, and a concert that finished `ok`.
  - Reuse: a leaf (code, host or assert) is reused when its recorded row is `ok` and its key matches. Groups re-enter.
- **Record**, schema version 2:
  - `instances` gains `key` and `stale`. A resume marks every row stale, a revisit replaces or reuses it, and the
    `stale` flag shows what an attempt left.
  - Spend from replaced attempts is kept in `earlier_metrics`, so a concert's metrics count every attempt.
  - A reused instance logs a `reused` event, and earlier events stay.

## Acceptance

Tests are in `packages/testkit/src/perform.test.ts` unless named.

| Item                                                             | Test                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A killed concert resumes without repeating an `ok` host node     | "a killed concert resumes without repeating an ok host node…" (SIGKILLs a real child process)    |
| A changed input or code hash reruns the affected nodes only      | `test.each` "a changed code hash reruns its node, and its dependents only with %s…"              |
| Of three identical `map` instances, only the non-`ok` one reruns | "of identical map instances a resume reruns only the one that did not settle ok"                 |
| The stored IR carries the current hashes                         | the same `test.each`; "a fresh concert stores and keys on the current code hashes, not the IR's" |
| A reject-then-accept host resumes to completion                  | "a host that rejects then accepts resumes to completion, the spend of both attempts kept"        |
| A live concert, or one that finished `ok`, is refused            | "a concert whose process is alive is not resumed…", "a concert that finished ok is not resumed"  |
| An artifact input counts by content hash                         | "an input artifact counts by its content hash, not its path…"                                    |
| Another schema version is refused                                | `core/src/perform/record.test.ts` "a record store of another schema version is refused…"         |

## Derived, not ruled

| Decision                                                                      | Source                                                   | Strength       | Reversal | Landed              |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- | -------------- | -------- | ------------------- |
| A dependent reruns only when its inputs changed                               | CORE-09 key wording; owner's ruling on pack hashes (K66) | decided        | cheap    | `resumeKey`         |
| Only leaves are reused; groups re-enter                                       | Brief deliverable 2; the `map` acceptance item           | decided        | cheap    | `perform.ts:leaf`   |
| A reused instance takes no concurrency slot                                   | Brief deliverable 4                                      | decided        | cheap    | `leaf`, `settle`    |
| A `rejected` or `failed` concert resumes; an `ok` one is refused              | CORE-09: "a failed or killed concert resumes"            | decided        | cheap    | `record.ts:restart` |
| Resume keeps `started_at`                                                     | Architecture 7: resume keeps the concert                 | by consistency | cheap    | `restart`           |
| `earlier_metrics` keeps replaced spend per concert and name, not per instance | GLOSSARY "Metric", CORE-19                               | by consistency | contract | `record.ts:SCHEMA`  |
| Event `{type: "reused"}`; columns `key` and `stale`; schema version 2         | Brief deliverable 4; architecture 10                     | by consistency | contract | `record.ts`         |
| `CodeHash` is async                                                           | Its sibling `LoadCode`                                   | by consistency | cheap    | `resume.ts`         |
| The pid-reuse guard on the live refusal waits for S6's `kill`                 | One check, where `kill` needs it                         | by consistency | cheap    | S6                  |

Left for S6: how `ls` shows stale rows.

## Review triage

| #   | Finding                                                            | Verdict  | Reason                                                |
| --- | ------------------------------------------------------------------ | -------- | ----------------------------------------------------- |
| 1   | A rerun deletes the first attempt's metrics                        | Accepted | Metrics are spend (CORE-19)                           |
| 2   | Schema changed, version stayed 1                                   | Accepted | Architecture 10 refuses other versions                |
| 3   | Stale rows read as current                                         | Accepted | Exposed as `stale`; display is S6's                   |
| 4   | Resume accepts an `ok` concert                                     | Accepted | CORE-09; reuse of finished work is fork               |
| 5   | A fresh concert keys stdlib nodes on the IR's version              | Accepted | ADR 0008                                              |
| 6   | Dependents rerun only on changed inputs, against architecture text | Raised   | The owner ruled it through pack hashes; docs reworded |
| 7   | `CodeHash` synchronous                                             | Accepted | Matches `LoadCode`; the S6 loader is async            |
| 8   | The refusal can name a dead pid                                    | Accepted | Read in the same transaction                          |
| 9   | Canonical JSON duplicated                                          | Accepted | One copy in `@maestro/ir`                             |
| 10  | `CodeHash` doc names its supplier                                  | Accepted | Docstring rules                                       |
| 11  | `PerformOptions` doc runs alternatives as prose                    | Accepted | Docstring rules                                       |

## Loop

| Step      | Findings | Accepted     | Changed code or design                            | Spend[^1]       |
| --------- | -------- | ------------ | ------------------------------------------------- | --------------- |
| Implement | n/a      | n/a          | deliverables 1–4                                  | 192k tok, 9 min |
| Gate      | 0        | n/a          | none                                              | conductor       |
| Review    | 11       | 10, 1 raised | code (all 10); design (record schema, `CodeHash`) | 135k tok, 5 min |
| Fix 1     | n/a      | n/a          | findings 1–5, 7–11                                | 33k tok, 3 min  |
| Fix 2     | n/a      | n/a          | one `isPlainObject`, in `@maestro/ir`             | 2k tok, <1 min  |

[^1]: Tokens and wall time from each agent's completion notice.

## `just check`

After fix round 2, run by the conductor: Biome, Prettier and `tsc` are clean, and `bun test` gives 644 pass and 0 fail
across 30 files.
