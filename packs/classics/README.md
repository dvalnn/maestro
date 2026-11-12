# classics

For whoever runs or builds on the classics pack: its compositions, profiles and params.

Compositions for building and reviewing a change in a target repository, on the coding-agent host. A release installs
the pack ([INSTALL](../../INSTALL.md)); a checkout lists this directory under `packs` in `.maestro/config.yaml`. Params
are flags in kebab-case, or config under `classics.<composition>.<param>`. Its seats run the profiles under `profiles/`,
`classics/<name>`; the pack names no models, so set each profile's `runtime` in config, as
`profiles.classics/<name>.runtime`.

## Compositions

| Composition          | What it does                                                                                                         | Profiles                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `build_then_repair`  | Builds the request in a fresh lane, repairs until the checks pass, leaves a patch series                             | `builder`                                              |
| `build_then_review`  | Builds the request, with tests pinned first when `tested`, then repairs and reviews by panel, fixing what it upholds | `builder`, `lens`, `skeptic`, `consolidator`, `tester` |
| `repair_until_green` | Checks a lane, then repairs in the builder's session while red; used by others                                       | `builder`                                              |
| `panel_review`       | Rules on a change through each lens, a skeptic over each lens's findings, then tallies                               | `lens`, `skeptic`, `consolidator`                      |
| `test_first`         | A tester pins the spec in tests and maps them; a builder extends its lane to pass them                               | `tester`, `builder`                                    |

`scout` and `planner` serve no composition of the pack; they are seats for compositions built on it. A `scout` answers
the questions it is asked in an `answers` reply field: per question, its `state` (`grounded` or `unsure`), what is
`missing` when unsure, and the Markdown answer.

Each profile's `skills` key names the skills it loads, such as `writing-for-agents`, the guide the `builder` writes
Markdown by and the review seats judge it by. The skills are adapted from Matt Pocock's under the MIT license in
`skills/LICENSE`, each copy recorded in `skills/UPSTREAM.md`; the profiles under `profiles/` say which seat loads which.
A profile may name files anywhere inside its namespace directory, here `profiles/`; copy the whole `profiles/` to shadow
the pack.

Each `profile.yaml` sets limits: `builder` 45 minutes and 30M tokens, `lens`, `skeptic`, `consolidator` and `tester` 20
minutes and 10M tokens, the others none. None sets a `context` policy, so the harness compacts on its own terms; set one
in config as `profiles.classics/<name>.context`.

## Params

| Composition          | Param        | Type                                   | Default   | What it is                                                                                                          |
| -------------------- | ------------ | -------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `build_then_repair`  | `request`    | text                                   | required  | What to build                                                                                                       |
|                      | `maxRepairs` | integer, at least 1                    | 2         | The most repairs before the checks count as red                                                                     |
| `build_then_review`  | `request`    | text                                   | required  | What to build                                                                                                       |
|                      | `tested`     | boolean                                | false     | A tester pins the request in tests before the builder builds                                                        |
|                      | `maxFixes`   | integer, at least 1                    | 2         | The most fix rounds after a review upholds findings                                                                 |
|                      | `maxRepairs` | integer, at least 1                    | 2         | The most repairs before the checks count as red                                                                     |
| `repair_until_green` | `maxRepairs` | integer, at least 1                    | 2         | As above; a composition that uses it sets its own                                                                   |
|                      | `checks`     | list of `target.checks` names          | none      | The checks the repair agent may run on its repair                                                                   |
|                      | `fix`        | name in `target.checks`                | none      | Runs before each check and recheck, to fix what a script can; judged by the check that follows, which runs it again |
| `panel_review`       | `request`    | text                                   | required  | What the change must do                                                                                             |
|                      | `change`     | lane ref, `<concert id>.<instance id>` | optional² | The lane version under review                                                                                       |
|                      | `revs`       | git revisions: `A..B`, `C^!` or `B`    | optional² | The target commits under review                                                                                     |
|                      | `lenses`     | list of `correctness`, `spec`, `tests` | all three | The lenses to rule through, each once                                                                               |
| `test_first`         | `request`    | text                                   | required  | What to build                                                                                                       |
|                      | `checks`     | list of `target.checks` names          | none      | The checks the tester and the builder may run                                                                       |

² Exactly one of `change` and `revs`. `revs` is resolved against the target once, as the concert starts: `B` alone runs
from `target.base`, and the commits must be one linear series, with no merge.

Lenses run on the `lens` profile's model and skeptics on the `skeptic`'s. Pick models of different families: a skeptic
of the lens's family tends to share its blind spots. `panel_review` always runs them. The exported `panel`, which
compositions built on the pack `use`, takes `skeptics: false`: no skeptic runs, and the consolidator rules on every
finding unverified. It ends in a `Tally`, and with `consolidate: false` has no consolidator.

The exported `fix_until_clean` is a loop of `repair_until_green` and `panel`: while the panel's `Tally` upholds a
finding, a builder fixes it in its session and the round runs again, up to `maxFixes` times. It forwards `maxRepairs`,
`checks`, `fix` and the panel's `lenses`, `skeptics`, `consolidate` and `grounds`.

`build_then_review` is `build_then_repair` with a review: `fix_until_clean` over the build, ending in a patch series.
The lenses judge the request, with the tester's map and the builder's overrules when `tested`. Tune the panel in config
under `classics.panel.*`. The concert settles `rejected`, with the series left, while the last panel upholds a finding.
Example: `maestro perform classics.build_then_review --request "<what to build>" --tested`.
