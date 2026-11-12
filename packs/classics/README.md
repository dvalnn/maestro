# classics

For whoever runs or builds on the classics pack: its blocks, profiles and params.

Blocks for building and reviewing a change in a target repository, on the coding-agent host, in five layers. A release
installs the pack ([INSTALL](../../INSTALL.md)); a checkout lists this directory under `packs` in
`.maestro/config.yaml`. Params are flags in kebab-case, or config under `classics.<composition>.<param>`. Its seats run
the profiles under `profiles/`, `classics/<name>`; the pack names no models, so set each profile's `runtime` in config,
as `profiles.classics/<name>.runtime`.

| Layer     | Holds                                                                     |
| --------- | ------------------------------------------------------------------------- |
| Entries   | Compositions a user performs as `classics.<id>`                           |
| Patterns  | Compositions other compositions `use`, each a stage of building or review |
| Moves     | Functions returning one node: a skeptic, a fix, a tally                   |
| Contracts | The typed reply fields and code-node values the layers above pass on      |
| Seats     | One agent role each, bound to a profile                                   |

A consumer takes the layer it needs: perform an entry, `use` a pattern in its own composition, or call a move or seat
among its own nodes. The exports are in `src/index.ts`; `@maestro/classics/code` exports the code-node functions alone.

## Entries

| Entry               | What it does                                                                                                         | Profiles                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `build_then_repair` | Builds the request in a fresh lane, repairs until the checks pass, leaves a patch series                             | `builder`                                              |
| `build_then_review` | Builds the request, with tests pinned first when `tested`, then repairs and reviews by panel, fixing what it upholds | `builder`, `lens`, `skeptic`, `consolidator`, `tester` |
| `panel_review`      | Rules on a change through each lens, a skeptic over each lens's findings, then tallies                               | `lens`, `skeptic`, `consolidator`                      |

Example: `maestro perform classics.build_then_review --request "<what to build>" --tested`.

`build_then_review` is `build_then_repair` with a review: `fix_until_clean` over the build, ending in a patch series.
The lenses judge the request, with the tester's map and the builder's overrules when `tested`. Tune the panel in config
under `classics.panel.*`, its params in the [Params](#params) table. The concert settles `rejected`, with the series
left, while the last panel upholds a finding.

## Patterns

| Pattern              | What it does                                                                                    | Ports                                                        | Profiles                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `repair_until_green` | Checks a lane, then repairs in the builder's session while red                                  | `lane`, `session`, `spec`                                    | `builder`                                    |
| `panel`              | Rules through a lens per name, a skeptic over each, a consolidator; ends in a `Tally`           | `change`, `spec`, `session`¹, `earlier`¹, `names`¹, `brief`¹ | `lens`, `skeptic`², `consolidator`²          |
| `fix_until_clean`    | Loops `repair_until_green` and `panel`; while the `Tally` upholds a finding, a builder fixes it | `lane`, `session`, `spec`, `brief`                           | `builder`, `lens`, `skeptic`, `consolidator` |
| `test_first`         | A tester pins the spec in tests and maps them; a builder extends its lane to pass them          | `spec`                                                       | `tester`, `builder`                          |

¹ Optional. ² Not used when its param, `skeptics` or `consolidate`, is false.

`panel` takes `lenses`, a map of lens name to task text, `skeptics`, `consolidate`, `grounds` and `checks`; the
[Params](#params) table has their defaults. Without `skeptics`, no skeptic runs and the consolidator rules on every
finding unverified. Without `consolidate`, no consolidator runs and it needs a `session`. `earlier` is the previous
round's `Upheld`, which each lens reads; `names` sets the lenses at run time. Its `Tally` rejects while a finding is
upheld, so `ok` means clean.

`fix_until_clean` forwards `maxRepairs`, `checks`, `fix` and the panel's `lenses`, `skeptics`, `consolidate` and
`grounds`, and runs at most `maxFixes` fix rounds; a panel param it leaves unset stays the panel's own. `test_first`
gives the built lane and the tester's `TestMap`; its builder replies with the `Overrules` of any test it rejects.

## Moves

- `challenge`: a skeptic over any lens's findings, skipped when the lens settled ok; takes `grounds`, the rules a
  finding must cite.
- `fix`: a builder fixing the findings a round upheld, in a lane extending its lane and continuing its session.
- `tally`: the `Tally` of a review of a lane, over `held` findings, with a consolidator's `verdict`, `review` and the
  builder's `brief` when given.

## Contracts

| Contract                | Holds                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Finding`, `Findings`   | A lens's defect: `id`, `where`, `issue`, and `cites`, the guideline it breaks; none when clean                                                   |
| `Rulings`               | A skeptic's `holds` and `why` per finding id                                                                                                     |
| `Verdict`               | A consolidator's `criteria` met or not, and `upholds`, the `<lens>/<id>` it keeps; each criterion ruled not met is upheld as `consolidator/<id>` |
| `Upheld`                | A finding a review held, with its `lens` and the skeptic's `why`                                                                                 |
| `Tally`                 | What a review settles to: the `lane`, the builder's `session` and the `upheld` list                                                              |
| `TestMap`               | The tester's `pinned` requirements with test and `misses`, `deferred` and `untestable` ones                                                      |
| `Brief`                 | A builder's `summary` and `gaps`, for the review seats                                                                                           |
| `Overrule`, `Overrules` | A tester's test a builder rejects, and why                                                                                                       |
| `Answers`               | A scout's answer per question: `grounded`, or `unsure` with what is `missing`                                                                    |

`Findings`, `Rulings` and `Verdict` are exported as types only; a reply declares `List(Finding)` for findings. Read a
run's reply fields with `maestro ls <id> --json | jq .outputs`.

Code-node values: `toMarkdown`, `specOf`, `briefOf`, `heldOf`, `tallyOf` and `resultOf`. `fill` fills prompt
placeholders, `LENSES` holds each lens's task, and `atLeastOne` is an integer param of at least 1. `maxRepairs` and
`maxFixes` are the params of those names, for a composition built on the pack to reuse.

## Seats and profiles

| Seat           | Profile                 | Reply or output     | Skills                                                                                              |
| -------------- | ----------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `builder`      | `classics/builder`      | the lane            | `tdd`, `good-tests`, `codebase-design`, `code-smells`, `domain-modeling`, `writing-for-agents`      |
| `tester`       | `classics/tester`       | `map`: `TestMap`    | `tdd`, `good-tests`, `codebase-design`                                                              |
| `lens`         | `classics/lens`         | `findings`          | `good-tests`, `codebase-design`, `code-smells`, `writing-for-agents`                                |
| `skeptic`      | `classics/skeptic`      | `rulings`           | as `lens`                                                                                           |
| `consolidator` | `classics/consolidator` | `verdict`, `review` | as `lens`                                                                                           |
| `scout`        | `classics/scout`        | `answers`           | `codebase-design`                                                                                   |
| `planner`      | `classics/planner`      | `plan`              | `codebase-design`, `codebase-deepening`, `design-it-twice`, `domain-modeling`, `writing-for-agents` |

`scout` and `planner` serve no composition of the pack; they are seats for compositions built on it. The skills are
adapted from Matt Pocock's under the MIT license in `skills/LICENSE`, each copy recorded in `skills/UPSTREAM.md`. A
profile may name files anywhere inside its namespace directory, here `profiles/`; copy the whole `profiles/` to shadow
the pack.

Each `profile.yaml` sets limits: `builder` 45 minutes and 30M tokens, `lens`, `skeptic`, `consolidator` and `tester` 20
minutes and 10M tokens, the others none. None sets a `context` policy, so the harness compacts on its own terms; set one
in config as `profiles.classics/<name>.context`. Lenses run on the `lens` profile's model and skeptics on the
`skeptic`'s; pick models of different families, since a skeptic of the lens's family tends to share its blind spots.

## Params

| Composition          | Param                                          | Type                                   | Default     | What it is                                                                                                          |
| -------------------- | ---------------------------------------------- | -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `build_then_repair`  | `request`                                      | text                                   | required    | What to build                                                                                                       |
|                      | `maxRepairs`                                   | integer, at least 1                    | 2           | The most repairs before the checks count as red                                                                     |
| `build_then_review`  | `request`                                      | text                                   | required    | What to build                                                                                                       |
|                      | `tested`                                       | boolean                                | false       | A tester pins the request in tests before the builder builds                                                        |
|                      | `maxFixes`                                     | integer, at least 1                    | 2           | The most fix rounds after a review upholds findings                                                                 |
|                      | `maxRepairs`                                   | integer, at least 1                    | 2           | The most repairs before the checks count as red                                                                     |
| `repair_until_green` | `maxRepairs`                                   | integer, at least 1                    | 2           | As above; a composition that uses it sets its own                                                                   |
|                      | `checks`                                       | list of `target.checks` names          | none        | The checks the repair agent may run on its repair                                                                   |
|                      | `fix`                                          | name in `target.checks`                | none        | Runs before each check and recheck, to fix what a script can; judged by the check that follows, which runs it again |
| `panel_review`       | `request`                                      | text                                   | required    | What the change must do                                                                                             |
|                      | `change`                                       | lane ref, `<concert id>.<instance id>` | optional³   | The lane version under review                                                                                       |
|                      | `revs`                                         | git revisions: `A..B`, `C^!` or `B`    | optional³   | The target commits under review                                                                                     |
|                      | `lenses`                                       | list of `correctness`, `spec`, `tests` | all three   | The lenses to rule through, each once                                                                               |
| `panel`              | `lenses`                                       | map of lens name to task text          | the three   | The lenses to rule through, as `panel_review`'s but named by task text, not by lens name                            |
|                      | `skeptics`                                     | boolean                                | true        | A skeptic rules on each lens's findings; false leaves the consolidator to rule on all of them unverified            |
|                      | `consolidate`                                  | boolean                                | true        | A consolidator rules on the held findings; false needs a `session`                                                  |
|                      | `grounds`                                      | text                                   | empty       | The rules a finding must cite, held by the skeptics and the consolidator                                            |
|                      | `checks`                                       | list of `target.checks` names          | none        | The checks the lenses may run                                                                                       |
| `fix_until_clean`    | `maxFixes`                                     | integer, at least 1                    | 2           | The most fix rounds after a review upholds findings                                                                 |
|                      | `maxRepairs`, `checks`, `fix`                  | as `repair_until_green`                | as there    | Forwarded to `repair_until_green`                                                                                   |
|                      | `lenses`, `skeptics`, `consolidate`, `grounds` | as `panel`                             | the panel's | Forwarded to `panel` when set                                                                                       |
| `test_first`         | `request`                                      | text                                   | required    | What to build                                                                                                       |
|                      | `checks`                                       | list of `target.checks` names          | none        | The checks the tester and the builder may run                                                                       |

³ Exactly one of `change` and `revs`. `revs` is resolved against the target once, as the concert starts: `B` alone runs
from `target.base`, and the commits must be one linear series, with no merge.

## Recipes

`src/recipes.ts` holds five compositions of these blocks as test fixtures to copy from, not exports:

- fix ladder: fix rounds on a cheap builder seat, then a gated, reviewed fix on a stronger one.
- lens fusion: the same lens on two harness families, a skeptic over each, one tally over both.
- ruling vote: three skeptics over one lens, a finding standing when most hold it.
- audit sweep: a lens per area over the base, with no change under review.
- plan review: a planner writes the plan, and the panel rules on it over a sealed base.
