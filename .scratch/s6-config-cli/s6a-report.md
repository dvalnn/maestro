# S6a. Loader and config: slice report

Brief: `.scratch/s6-config-cli/spec.md`, "S6a".

## Done

- **Config** (`core/src/config`): YAML layers with `!replace`, `!append` and `!delete`, file and line per value, path
  keys anchored at the setting file's directory, the closed core schema (`concurrency`, `caps`, `dataRoot`,
  `workspace`). Any other tag, a YAML merge key (`<<`) and a misplaced tag are refused at their file and line.
- **Files** (`cli/src/config.ts`): default < `$XDG_CONFIG_HOME/maestro/config.yaml` < the nearest `.maestro/config.yaml`
  < `.maestro/profiles/<name>.yaml`. `packs` is the CLI's key.
- **Claims** (`core/src/compose/checks.ts`): packs claim their id, compositions and params; an unclaimed key at any
  level fails with a did-you-mean; a pack id another owner claims is `CFG.claim`. The IR's `config` block is gone.
- **Params** (`cli/src/params.ts`): config < example set < flag under `<pack>.<composition>`, kebab-case flags, typed
  params read through `Host.param`.
- **Glue** (`sdk/src/composition.ts`): `describe()` and `build(name, params, context)` over plainly exported
  compositions.
- **Loader** (`cli/src/loader.ts`): packs, bare files bundled in memory, and IR files whose modules must be
  self-contained. Every module is imported from the bytes it hashed. `withCurrentHashes` is exported, so a caller
  rehashes a stored IR before compose.
- **ADR 0008** records each loader's `codeHash` form.

## Acceptance

| Item                                                      | Test                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Precedence and provenance across every layer              | `cli/src/config.test.ts` "layer default, user, workspace and profile…"; `params.test.ts` "resolve…"      |
| The merge tags                                            | `core/src/config/index.test.ts` "!replace, !append and !delete…", "refuses %s, naming the file and line" |
| Did-you-mean at each claim level                          | `core/src/compose/checks.test.ts` config "rejects %s", "locates a config error at the file and line…"    |
| A pack, a bare file and an IR file build or load and fold | `cli/src/loader.test.ts`, one test each                                                                  |
| A module whose bytes differ from its `codeHash` fails     | loader.test "refuses %s before any node starts"                                                          |
| A missing stdlib export is a compose error                | loader.test "resolves maestro:stdlib to the engine's stdlib…"                                            |
| A typed param through the fake host                       | params.test "is read through its host…", "refuses malformed text, naming the flag"                       |
| Resume after a changed pack reruns its code node only     | loader.test resume: compose fails on the stale IR, rehash then compose passes, the resume reruns         |

## Raised

Each is built with its default and waits on the owner.

| #   | Call                                 | Default                                                |
| --- | ------------------------------------ | ------------------------------------------------------ |
| K93 | Default `concurrency`                | Ruled: the CPU count (`availableParallelism()`)        |
| K94 | A bare file's pack id and version    | Ruled: the file stem, `0.0.0`                          |
| K95 | `compose --out` of a bare file       | Ruled: emit the bundle beside the IR (S6b)             |
| K96 | A cross-pack subcomposition's params | Ruled: config follows the bundle (sdk-spec 9)          |
| K97 | "build" in `packages/cli`            | Ruled: allowed; `cli` is in the word scan with `build` |

## Derived, not ruled

| Decision                                                                                           | Source                                      | Strength       | Reversal | Landed                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------- | -------- | ------------------------- |
| `maestro-pack.json` is `{id, version, entry, sdk, hosts}`                                          | Brief deliverable 5                         | decided        | contract | loader `MANIFEST_SCHEMA`  |
| Host versions come through `Versions.hosts`, not a `Host` field                                    | Backlog 17 (keep `Host` narrow)             | by consistency | cheap    | loader `checkVersions`    |
| Any tag but the three merge tags is refused, `!!str` included                                      | Brief deliverable 1                         | decided        | cheap    | core config               |
| YAML merge keys (`<<`) are refused                                                                 | The merge tags cover merging                | by consistency | cheap    | core config `keyOf`       |
| `Host.param` is synchronous                                                                        | It parses text; I/O checks are `validate`'s | by consistency | contract | `core/src/host.ts`        |
| Codes `CFG.yaml`, `CFG.tag`, `CFG.required`, `CFG.profile`, `CFG.param`, `CFG.schema`, `CFG.claim` | Existing code families                      | by consistency | contract | core config, compose, cli |
| Exports are looked up by dotted name, one level down                                               | Backlog 08 spike                            | decided        | contract | loader `exported`         |
| `describe()` gives params as one object JSON Schema                                                | Brief "params as JSON Schema"               | decided        | contract | sdk `Described`           |
| An IR-file module may import only builtins and `@maestro/sdk`                                      | ADR 0008 `codeHash` covers reached code     | decided        | contract | loader `outsideOf`        |
| A load error's lines after the first become the `SCOPE.export` hint                                | The "what, then fix" error shape            | by consistency | cheap    | compose `fold.ts`         |
| A pack id another owner claims is refused                                                          | CFG-02, one owner per key                   | decided        | cheap    | compose `collisions`      |
| XDG fallbacks `~/.config`, `~/.local/share`                                                        | XDG spec                                    | decided        | cheap    | cli `xdg`                 |
| A profile needs a workspace, and takes a name, not a path                                          | Profiles live under `.maestro/`             | decided        | cheap    | cli `profileLayer`        |
| Core exports `./config`, `./ports` and `./shared`                                                  | Reuse rung                                  | by consistency | cheap    | `core/package.json`       |

## Review triage

| #   | Finding                                                   | Verdict  | Reason                                   |
| --- | --------------------------------------------------------- | -------- | ---------------------------------------- |
| 1   | An IR-file module's helpers escape its `codeHash`         | Accepted | ADR 0008; modules must be self-contained |
| 2   | Resume pre-flight fails after a pack changed              | Accepted | Brief deliverable 11, K86                |
| 3   | A used host's absent namespace skips its schema           | Accepted | CFG-02 regression                        |
| 4   | `demo.constructor` crashes compose                        | Accepted | CFG-05                                   |
| 5   | Bundler errors drop the import and position               | Accepted | clig.dev                                 |
| 6   | Example set against flag untested                         | Accepted | Brief deliverable 4                      |
| 7   | Untested loader branches                                  | Accepted | Tests rule                               |
| 8   | `--profile ../x` gives the wrong error                    | Accepted | clig.dev                                 |
| 9   | `dataRoot: ""` accepted                                   | Accepted | CFG-01 schema                            |
| 10  | Hash-mismatch error has no fix; wrong `SCOPE.export` hint | Accepted | CODING_STANDARDS output                  |
| 11  | YAML merge keys become a literal `<<` key                 | Accepted | Brief deliverable 1                      |
| 12  | A pack id may collide with another namespace              | Accepted | CFG-02                                   |
| 13  | `messageOf`, SHA-256 and a dummy `WorkerRef` duplicated   | Accepted | Ladder rung 2                            |
| 14  | Exports wider than needed                                 | Accepted | NFR-09                                   |
| 15  | Docstrings name their callers                             | Accepted | Docstring rules                          |

## Loop

| Step      | Findings | Accepted | Changed code or design                                           | Spend[^1]       |
| --------- | -------- | -------- | ---------------------------------------------------------------- | --------------- |
| Implement | n/a      | n/a      | deliverables 1–7, `Host.param`                                   | 87k tok, 38 min |
| Gate      | 0        | n/a      | none                                                             | conductor       |
| Review    | 15       | 15       | code (all); design (IR-file modules self-contained, `CFG.claim`) | 157k tok, 7 min |
| Fix 1     | n/a      | n/a      | findings 1–15                                                    | 183k tok, 8 min |

[^1]: Tokens and wall time from each agent's completion notice.

## `just check`

After fix round 1, run by the conductor: Biome, Prettier and `tsc` are clean, and `bun test` gives 715 pass and 0 fail
across 34 files.
