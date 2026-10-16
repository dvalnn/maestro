# S6b. CLI verbs: slice report

Brief: `.scratch/s6-config-cli/spec.md`, "S6b".

## Done

- **Verbs** (`packages/cli/src`): `compose` (`c`), `perform` (`p`), `ls`, `wait` (`w`), `kill` (`k`), `config` (`cfg`),
  `prune` and `tour`, parsed with `parseArgs`, each module loaded on demand. `maestro.ts` is the bin entry, with no
  hosts until S8e.
- **Flags**: params in kebab-case, checked against every verb's own flags; durations per K98.
- **Output**: `--json` prints one document on stdout for every result and every error (`{ok:false, error, exit}`, or
  `{ok:false, diagnostics}`); field names follow the record's columns. One diagnostic renderer; exit codes 0, 1, 2, 3
  and 124.
- **`compose --out`**: a pack's modules rewritten relative to the output; a bare file's bundle written beside it (K95).
- **Resume**: rehashes before pre-flight; a pack from its stored directory, a bare file re-bundled from its current
  source, so changed code reruns.
- **`kill`**: signals only a process whose executable or script is maestro. A live pid that belongs to another program
  is not signalled; the concert is settled `failed` so it can be resumed or pruned.
- **`prune`**: each host's `release` first, a row re-read before release, a host failure or a concert running again
  keeping it; confirmation on a TTY, `--yes` otherwise.
- **Record**: schema version 3, the concert row gaining `workspace`, `tour`, `title`, `moduleDir` and `file`;
  `RecordStore.find`, `setTour` and `remove`. `perform` takes an optional `origin` for the row.
- **Host**: optional `release(concert)` and `usage(concert)`, on the fake host too. `packages/cli/README.md`.

## Acceptance

Tests are in `packages/cli/src/cli.test.ts` unless named; `process.test.ts` runs real processes.

| Item                                                                        | Test                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| AC-6: each verb by name and alias, `--json`, exit codes 0, 1, 3             | "perform > a concert that settles %s…", "compose prints…", "config lists…", "wait exits…"                                  |
| Exit 2 and one JSON document per usage error                                | "usage errors > %s exits 2 and says what to do", run with and without `--json`                                             |
| Exit 124 on a wait timeout                                                  | `process.test.ts` "is waited on, refused a resume and a prune while running…"                                              |
| A compose error starts no concert (NFR-02)                                  | "a compose error stops it before any node starts"                                                                          |
| AC-8: a hand-written IR file performs with no SDK import                    | "a golden IR file performs through the CLI"                                                                                |
| `compose --out` IR performs, from a pack and a bare file                    | "--out of a pack writes an IR that performs…"                                                                              |
| Kill, then resume without repeating an `ok` node, after a change            | `process.test.ts` "…killed, then resumed from the changed pack…", "a bare file's concert resumes from its current source…" |
| Resuming a live or `ok` concert is refused                                  | `process.test.ts`, the same tests                                                                                          |
| `kill` never signals another program                                        | `process.test.ts` "kill > never signals a live process that is not maestro…"                                               |
| Tours and titles set, changed, listed and filtered                          | "tours and titles are set at perform…"                                                                                     |
| `prune` removes record, artifacts and host resources; refuses a running one | "prune > deletes…", "--before takes…", "a host that cannot release…"                                                       |
| `ls` shows disk use                                                         | "ls shows the disk a concert holds…"                                                                                       |
| `ls` cold start (NFR-03, under 150 ms)                                      | Measured by the conductor: 10 fresh `maestro ls` runs, 70 to 73 ms                                                         |
| No domain words in `cli`                                                    | `core/src/domain-words.test.ts`                                                                                            |

## Raised

| #    | Call                                              | Default                                                |
| ---- | ------------------------------------------------- | ------------------------------------------------------ |
| K100 | Exit code of a state refusal versus an unknown id | Ruled: 1 for a refusal, 2 for an id that names nothing |
| K101 | Data root layout                                  | Ruled: `record.db` and `concerts/<id>/`                |
| K102 | A bare file exporting several compositions        | Ruled: a usage error; the selector is backlog 18       |
| K103 | `--no-<flag>` for booleans                        | Ruled: kept                                            |

## Derived, not ruled

| Decision                                                                            | Source                            | Strength       | Reversal | Landed          |
| ----------------------------------------------------------------------------------- | --------------------------------- | -------------- | -------- | --------------- |
| Schema version 3 with `workspace`, `tour`, `title`, `moduleDir`, `file`             | Deliverable 17; S5's version bump | by consistency | contract | `record.ts`     |
| A bare-file concert resumes from its current source                                 | Deliverable 11, K86               | decided        | cheap    | `prepare.ts`    |
| `--json` errors print `{ok:false, error, exit}` on stdout                           | K99, one document per command     | by consistency | contract | `cli.ts:report` |
| `perform`, `wait`, `kill` print `{id, status, resultNode, resultExpansion, reason}` | K99                               | decided        | contract | `output.ts`     |
| `kill` waits up to 10 s for the concert to settle                                   | Deliverable 12                    | by consistency | cheap    | `records.ts`    |
| `wait --json` on a timeout prints the concert as `running`, exit 124                | K78, K99                          | by consistency | cheap    | `records.ts`    |
| Reaping uses core's `processExists`; `isMaestro` gates only `kill`                  | Deliverable 12                    | decided        | cheap    | `session.ts`    |
| Tour slugs `^[a-z0-9]+(-[a-z0-9]+)*$`, 64 characters at most                        | Deliverable 16                    | decided        | contract | `output.ts`     |
| `--resume` refuses a composition, `--tour` and `--title`                            | Resume keeps the concert's own    | by consistency | cheap    | `perform.ts`    |
| `config` shows no example set                                                       | CLI-02, deliverable 4             | decided        | cheap    | `compose.ts`    |
| Compose scratch in the OS temp dir, removed after pre-flight                        | Compose starts no node            | by consistency | cheap    | `prepare.ts`    |
| The bin passes no hosts until S8e                                                   | Out of scope                      | decided        | cheap    | `maestro.ts`    |

## Review triage

| #   | Finding                                                     | Verdict  | Reason                                                        |
| --- | ----------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| 1   | `isMaestro` matched any argument                            | Accepted | Deliverable 12                                                |
| 2   | `isMaestro` reaped live concerts on every read              | Accepted | Deliverable 12's scope; round 2 closed the stuck case it left |
| 3   | `--json` printed nothing on most errors                     | Accepted | K99                                                           |
| 4   | `kill --json` hard-coded `failed`                           | Accepted | Record consistency                                            |
| 5   | A missing `.ts` target exited 1 with internal paths         | Accepted | K78, clig.dev                                                 |
| 6   | Param-flag clashes checked per verb                         | Accepted | Deliverable 9                                                 |
| 7   | `config` applied the example set                            | Accepted | CLI-02                                                        |
| 8   | `--no-<flag>` with no ruling                                | Raised   | K103                                                          |
| 9   | JSON field names drifted from the record                    | Accepted | K99                                                           |
| 10  | Wrong hint for parse errors under `--resume`                | Accepted | CLI-06                                                        |
| 11  | Duplicated helpers and casts                                | Accepted | Ladder rung 2                                                 |
| 12  | Magic constants                                             | Accepted | User rules                                                    |
| 13  | Docstrings naming callers; unwrapped lines                  | Accepted | User rules                                                    |
| 14  | A fake-host test restating the fake                         | Accepted | Tests rule                                                    |
| 15  | Report, cold start and the README's `workspace` key missing | Accepted | Brief; the report is the conductor's                          |
| 16  | A prune racing a resume released a live concert's resources | Accepted | Deliverable 14                                                |
| 17  | Core's message text matched to tell an unknown id           | Accepted | CODING_STANDARDS                                              |
| 18  | `compose --json` printed diagnostics twice                  | Accepted | No wrapper that adds nothing                                  |

The conductor also turned the implementer's raised R3, a bare-file concert pinning its bundle, into a fix: deliverable
11 and K86 have resume pick up changed code.

## Loop

| Step      | Findings | Accepted     | Changed code or design                                              | Spend[^1]        |
| --------- | -------- | ------------ | ------------------------------------------------------------------- | ---------------- |
| Implement | n/a      | n/a          | deliverables 8–18                                                   | 164k tok, 21 min |
| Gate      | 0        | n/a          | none                                                                | conductor        |
| Review    | 18       | 17, 1 raised | code (all); design (`kill` gate, resume from source, JSON envelope) | 251k tok, 8 min  |
| Fix 1     | n/a      | n/a          | findings and R3                                                     | 239k tok, 8 min  |
| Fix 2     | n/a      | n/a          | `kill` settles a concert whose pid another program holds            | 243k tok, 1 min  |

[^1]: Tokens and wall time from each agent's completion notice; the review ran as one agent reporting twice.

## `just check`

After fix round 2, run by the conductor: Biome, Prettier and `tsc` are clean, and `bun test` gives 795 pass and 0 fail
across 36 files.
