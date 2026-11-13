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

| Entry               | What it does                                                                                                  | Profiles                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `build_then_repair` | Builds the request in a fresh lane, repairs until the checks pass, leaves a patch series                      | `builder`, `tester`¹                                                                |
| `build_then_review` | Builds the request, then repairs and reviews by tiered review, fixing what it upholds                         | `builder`, `tester`¹, `lens`, `deep-lens`, `top-lens`, `cross-lens`, `consolidator` |
| `panel_review`      | Rules on a change through each lens, a skeptic over each lens's findings, then tallies                        | `lens`, `skeptic`, `consolidator`                                                   |
| `review_change`     | Rules on a change through the lenses its size picks, on one checklist from the paths it touches, then tallies | `lens`, `deep-lens`, `top-lens`, `cross-lens`, `consolidator`                       |

¹ Under `classics.build.testFirst`.

Example: `maestro perform classics.build_then_review --request "<what to build>" -c classics.build.testFirst=true`.

Both build through `build`: set `classics.build.testFirst` for tests first. `build_then_review` is `build_then_repair`
with a review: `fix_until_clean` over the build, ending in a patch series. The lenses judge the request, with the
tester's map and the builder's overrules when `classics.build.testFirst`. Tune the review in config under
`classics.tiered_review.*`, its params in the [Params](#params) table. The concert settles `rejected`, with the series
left, while the last review upholds a finding.

## Patterns

| Pattern              | What it does                                                                                                  | Ports                                                        | Profiles                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `repair_until_green` | Checks a lane, then repairs in the builder's session while red                                                | `lane`, `session`, `spec`                                    | `builder`                                                                |
| `panel`              | Rules through a lens per name, a skeptic over each, a consolidator; ends in a `Tally`                         | `change`, `spec`, `session`¹, `earlier`¹, `names`¹, `brief`¹ | `lens`, `skeptic`², `consolidator`²                                      |
| `tiered_review`      | Rules through the lenses the change's size picks, on one checklist, a consolidator; ends in a `Tally`         | `change`, `spec`, `session`¹, `earlier`¹, `brief`¹           | `lens`, `deep-lens`, `top-lens`, `cross-lens`, `consolidator`            |
| `fix_until_clean`    | Loops `repair_until_green` and `tiered_review`; while the `Tally` upholds a finding, a builder fixes it       | `lane`, `session`, `spec`, `brief`                           | `builder`, `lens`, `deep-lens`, `top-lens`, `cross-lens`, `consolidator` |
| `test_first`         | A tester pins the spec in tests and maps them; a builder extends its lane to pass them                        | `spec`                                                       | `tester`, `builder`                                                      |
| `build`              | Builds the request in a fresh lane, through `test_first` when `testFirst`; gives what `fix_until_clean` takes | `spec`                                                       | `builder`, `tester`²                                                     |

¹ Optional. ² Not used when its param, `skeptics`, `consolidate` or `testFirst`, is false.

`panel` takes `lenses`, a map of lens name to task text, `skeptics`, `consolidate`, `grounds` and `checks`; the
[Params](#params) table has their defaults. Without `skeptics`, no skeptic runs and the consolidator rules on every
finding unverified. Without `consolidate`, no consolidator runs and it needs a `session`. `earlier` is the previous
round's `Upheld`, which each lens reads; `names` sets the lenses at run time. Its `Tally` rejects while a finding is
upheld, so `ok` means clean.

`tiered_review` runs one `changeset` of the change through a selector, `tieredOf`, which counts the lines changed
outside the `ignore` globs and picks the tier: `small` up to `small` lines, `medium` up to `medium`, `large` up to
`large`, `xlarge` above; `floor` raises it. The tier seats its lenses, each a `parMap` of at most one: `lens` at small,
`deep-lens` at medium, `top-lens` at large, `top-lens` and `cross-lens` at xlarge. Every lens rules on the same
checklist: `correctness` and `spec` always, then `tests`, `design`, `smells`, `docs` and `agent-doc` for the paths the
change touches, each item numbered so a finding cites `<section> <n>`. One consolidator rules on what they held, and the
`Tally` rejects while a finding is upheld, or when no lens delivered a review. `earlier` is the previous round's
`Upheld`, which each lens reads.

`build` takes the request as `spec`, so only a composition `use`s it. It returns the `lane`, the builder's `session`, a
`spec` of the request, then the tester's map and the builder's overrules when `testFirst`, and the `brief`: the four
ports of `fix_until_clean`.

`fix_until_clean` forwards `checks` to `repair_until_green` and `grounds` to `tiered_review`, and runs at most
`maxFixes` fix rounds; a param it leaves unset stays the callee's own, so `classics.tiered_review.*` reaches it, and of
`classics.repair_until_green.*` the `maxRepairs` and `fix` params do. `test_first` gives the built lane and the tester's
`TestMap`; its builder replies with the `Overrules` of any test it rejects.

## Moves

- `challenge`: a skeptic over any lens's findings, skipped when the lens settled ok; takes `grounds`, the rules a
  finding must cite.
- `fix`: a builder fixing the findings a round upheld, in a lane extending its lane and continuing its session.
- `tally`: the `Tally` of a review of a lane, over `held` findings, with a consolidator's `verdict`, from which it
  renders the `review`, and the builder's `brief` when given.

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

Read a run's reply fields with `maestro ls <id> --json | jq .outputs`.

Code-node values: `toMarkdown`, `specOf`, `briefOf`, `heldOf`, `heldAcross`, `tallyOf`, `tieredOf` and `resultOf`.
`fill` fills prompt placeholders, `LENSES` holds each lens's task, and `atLeastOne` is an integer param of at least 1.
`maxRepairs` and `maxFixes` are the params of those names, for a composition built on the pack to reuse.

## Seats and profiles

| Seat           | Profile                 | Reply or output  | Instructions                    |
| -------------- | ----------------------- | ---------------- | ------------------------------- |
| `builder`      | `classics/builder`      | the lane         | `testing.md`, `instructions.md` |
| `tester`       | `classics/tester`       | `map`: `TestMap` | `testing.md`, `instructions.md` |
| `lens`         | `classics/lens`         | `findings`       | `instructions.md`[^lens]        |
| `deepLens`     | `classics/deep-lens`    | `findings`       | the `lens` instructions         |
| `topLens`      | `classics/top-lens`     | `findings`       | the `lens` instructions         |
| `crossLens`    | `classics/cross-lens`   | `findings`       | the `lens` instructions         |
| `skeptic`      | `classics/skeptic`      | `rulings`        | `instructions.md`               |
| `consolidator` | `classics/consolidator` | `verdict`        | `instructions.md`               |
| `scout`        | `classics/scout`        | `answers`        | `instructions.md`               |
| `planner`      | `classics/planner`      | `plan`           | `instructions.md`               |

[^lens]:
    Each lens's task holds a checklist drawn from `skills/`, which it rules on item by item; `LENSES` holds the tasks.

`scout` and `planner` serve no composition of the pack; they are seats for compositions built on it. No profile attaches
guidance: each seat's instructions carry what its one job needs, and `builder` and `tester` share `profiles/testing.md`
([ADR 0018](../../docs/adr/0018-the-graph-gives-guidance-and-the-agent-never-picks-it.md)). The text under `skills/` is
the source those instructions and checklists are written from, adapted from Matt Pocock's skills under the MIT license
in `skills/LICENSE`, each copy recorded in `skills/UPSTREAM.md`; no profile reads it. A profile may name files anywhere
inside its namespace directory, here `profiles/`; copy the whole `profiles/` to shadow the pack.

Each `profile.yaml` sets limits: `builder` 45 minutes and 30M tokens, the lens profiles, `skeptic`, `consolidator` and
`tester` 20 minutes and 10M tokens, the others none. None sets a `context` policy, so the harness compacts on its own
terms; set one in config as `profiles.classics/<name>.context`. Lenses run on the `lens` profile's model and skeptics on
the `skeptic`'s; pick models of different families, since a skeptic of the lens's family tends to share its blind spots.
In a tiered review, set each tier's seat to a stronger model than the last, and `cross-lens` to another family than
`top-lens`.

## Params

| Composition          | Param            | Type                                   | Default   | What it is                                                                                                          |
| -------------------- | ---------------- | -------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `build_then_repair`  | `request`        | text                                   | required  | What to build                                                                                                       |
|                      | `maxRepairs`     | integer, at least 1                    | 2         | The most repairs before the checks count as red                                                                     |
| `build_then_review`  | `request`        | text                                   | required  | What to build                                                                                                       |
|                      | `maxFixes`       | integer, at least 1                    | 2         | The most fix rounds after a review upholds findings                                                                 |
| `repair_until_green` | `maxRepairs`     | integer, at least 1                    | 2         | As above; a composition that uses it sets its own                                                                   |
|                      | `checks`         | list of `target.checks` names          | none      | The checks the repair agent may run on its repair                                                                   |
|                      | `fix`            | name in `target.checks`                | none      | Runs before each check and recheck, to fix what a script can; judged by the check that follows, which runs it again |
| `panel_review`       | `request`        | text                                   | required  | What the change must do                                                                                             |
|                      | `change`         | lane ref, `<concert id>.<instance id>` | optional³ | The lane version under review                                                                                       |
|                      | `revs`           | git revisions: `A..B`, `C^!` or `B`    | optional³ | The target commits under review                                                                                     |
|                      | `lenses`         | list of `correctness`, `spec`, `tests` | all three | The lenses to rule through, each once                                                                               |
| `panel`              | `lenses`         | map of lens name to task text          | the three | The lenses to rule through, as `panel_review`'s but named by task text, not by lens name                            |
|                      | `skeptics`       | boolean                                | true      | A skeptic rules on each lens's findings; false leaves the consolidator to rule on all of them unverified            |
|                      | `consolidate`    | boolean                                | true      | A consolidator rules on the held findings; false needs a `session`                                                  |
|                      | `grounds`        | text                                   | empty     | The rules a finding must cite, held by the skeptics and the consolidator                                            |
|                      | `checks`         | list of `target.checks` names          | none      | The checks the lenses may run                                                                                       |
| `tiered_review`      | `small`          | integer, at least 1                    | 200       | The most changed lines of a small change                                                                            |
|                      | `medium`         | integer                                | 800       | The most changed lines of a medium change; `small`, `medium` and `large` must rise                                  |
|                      | `large`          | integer                                | 2000      | The most changed lines of a large change; a bigger one is xlarge                                                    |
|                      | `ignore`         | list of globs                          | listed⁴   | Paths whose changed lines do not count                                                                              |
|                      | `floor`          | `small`, `medium`, `large`, `xlarge`   | none      | The tier a review is at least, however small the change                                                             |
|                      | `grounds`        | text                                   | empty     | The rules a finding must cite, held by the consolidator                                                             |
|                      | `checks`         | list of `target.checks` names          | none      | The checks the lenses may run                                                                                       |
| `review_change`      | `request`        | text                                   | required  | What the change must do                                                                                             |
|                      | `change`, `revs` | as `panel_review`                      | optional³ | The lane version or target commits under review                                                                     |
| `fix_until_clean`    | `maxFixes`       | integer, at least 1                    | 2         | The most fix rounds after a review upholds findings                                                                 |
|                      | `checks`         | as `repair_until_green`                | none      | Forwarded to `repair_until_green`, and the checks of the `fix` move                                                 |
|                      | `grounds`        | as `tiered_review`                     | unset     | Forwarded to `tiered_review` when set                                                                               |
| `test_first`         | `request`        | text                                   | required  | What to build                                                                                                       |
|                      | `checks`         | list of `target.checks` names          | none      | The checks the tester and the builder may run                                                                       |
| `build`              | `request`        | text                                   | required  | What to build                                                                                                       |
|                      | `testFirst`      | boolean                                | false     | A tester pins the spec in tests before the builder builds                                                           |
|                      | `checks`         | list of `target.checks` names          | none      | The checks the builder may run when `testFirst` is false                                                            |

³ Exactly one of `change` and `revs`. `revs` is resolved against the target once, as the concert starts: `B` alone runs
from `target.base`, and the commits must be one linear series, with no merge.

⁴ `**/*.lock`, `**/*.lockb`, `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/dist/**`, `**/*.generated.*` and
`**/*.min.*`.

## Recipes

`src/recipes.ts` holds five compositions of these blocks as test fixtures to copy from, not exports:

- fix ladder: fix rounds on a cheap builder seat, then a gated, reviewed fix on a stronger one.
- lens fusion: the same lens on two harness families, a skeptic over each, one tally over both.
- ruling vote: three skeptics over one lens, a finding standing when most hold it.
- audit sweep: a lens per area over the base, with no change under review.
- plan review: a planner writes the plan, and the panel rules on it over a sealed base.
