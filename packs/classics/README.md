# classics

Compositions for building and reviewing a change in a target repository, on the coding-agent host. Install the pack by
listing this directory under `packs` in a workspace's `.maestro/config.yaml`. Params are flags in kebab-case, or config
under `classics.<composition>.<param>`. Roles map to a harness and a model under `roles`; the pack names no models.

## Compositions

| Composition          | What it does                                                                                      | Roles                 |
| -------------------- | ------------------------------------------------------------------------------------------------- | --------------------- |
| `build_then_repair`  | Builds the request in a fresh lane, repairs until the target's checks pass, leaves a patch series | `builder`             |
| `repair_until_green` | Checks a lane, then repairs and checks again while the checks are red; used by others, not alone  | `builder`             |
| `panel_review`       | Rules on a change through each lens, a skeptic over each lens's findings, then consolidates       | `reviewer`, `skeptic` |
| `v_model`            | Scouts, plans, builds and repairs, reviews each scouted risk, traces acceptance to the plan       | all six¹              |

¹ `scout`, `planner`, `builder`, `reviewer`, `skeptic` and `documenter`.

## Params

| Composition          | Param           | Type                                   | Default   | What it is                                           |
| -------------------- | --------------- | -------------------------------------- | --------- | ---------------------------------------------------- |
| `build_then_repair`  | `request`       | text                                   | required  | What to build                                        |
|                      | `maxRepairs`    | integer, at least 1                    | 2         | The most repairs before the checks count as red      |
| `repair_until_green` | `maxRepairs`    | integer, at least 1                    | 2         | As above; a composition that uses it sets its own    |
| `panel_review`       | `request`       | text                                   | required  | What the change must do                              |
|                      | `change`        | lane ref, `<concert id>.<instance id>` | optional² | The lane version under review                        |
|                      | `revs`          | git revisions: `A..B`, `C^!` or `B`    | optional² | The target commits under review                      |
|                      | `lenses`        | list of `correctness`, `spec`, `tests` | all three | The lenses to rule through, each once                |
| `v_model`            | `request`       | text                                   | required  | What to build                                        |
|                      | `maxApproaches` | integer, at least 1                    | 2         | The most approaches the plan may give; more fails it |
|                      | `maxRisks`      | integer, at least 1                    | 4         | The most scouted risks the review rules on           |
|                      | `maxRepairs`    | integer, at least 1                    | 2         | The most repairs of each approach                    |

² Exactly one of `change` and `revs`. `revs` is resolved against the target once, as the concert starts: `B` alone runs
from `target.base`, and the commits must be one linear series, with no merge.

Lenses and consolidators run on the `reviewer` role's model, skeptics on the `skeptic` role's. Pick models of different
families for the two: a skeptic of the lens's family tends to share its blind spots.
