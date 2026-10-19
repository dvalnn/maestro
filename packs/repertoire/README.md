# repertoire

Compositions for building and reviewing a change in a target repository, on the coding-agent host. Install the pack by
listing this directory under `packs` in a workspace's `.maestro/config.yaml`. Params are flags in kebab-case, or config
under `repertoire.<composition>.<param>`. Roles map to a harness and a model under `roles`; the pack names no models.

## Compositions

| Composition          | What it does                                                                                      | Roles                  |
| -------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| `build_then_repair`  | Builds the request in a fresh lane, repairs until the target's checks pass, leaves a patch series | `builder`              |
| `repair_until_green` | Checks a lane, then repairs and checks again while the checks are red; used by others, not alone  | `builder`              |
| `review`             | Rules on a lane version through each lens, a skeptic over each lens's findings, then consolidates | `reviewer`, `skeptic`¹ |
| `v_model`            | Scouts, plans, builds and repairs, reviews each scouted risk, traces acceptance to the plan       | all six²               |

¹ `review` and `v_model` set the model of every lens and every skeptic from their params, over the role's own.

² `scout`, `planner`, `builder`, `reviewer`, `skeptic`¹ and `documenter`.

## Params

| Composition          | Param           | Type                                   | Default   | What it is                                           |
| -------------------- | --------------- | -------------------------------------- | --------- | ---------------------------------------------------- |
| `build_then_repair`  | `request`       | text                                   | required  | What to build                                        |
|                      | `maxRepairs`    | integer, at least 1                    | 2         | The most repairs before the checks count as red      |
| `repair_until_green` | `maxRepairs`    | integer, at least 1                    | 2         | As above; a composition that uses it sets its own    |
| `review`             | `request`       | text                                   | required  | What the change must do                              |
|                      | `change`        | lane ref, `<concert id>.<instance id>` | required  | The lane version under review                        |
|                      | `lensModel`     | text                                   | required  | The model every lens runs on                         |
|                      | `skepticModel`  | text                                   | required  | The model every skeptic runs on, of another family³  |
|                      | `lenses`        | list of `correctness`, `spec`, `tests` | all three | The lenses to rule through, each once                |
| `v_model`            | `request`       | text                                   | required  | What to build                                        |
|                      | `lensModel`     | text                                   | required  | As `review`'s                                        |
|                      | `skepticModel`  | text                                   | required  | As `review`'s³                                       |
|                      | `maxApproaches` | integer, at least 1                    | 2         | The most approaches the plan may give; more fails it |
|                      | `maxRisks`      | integer, at least 1                    | 4         | The most scouted risks the review rules on           |
|                      | `maxRepairs`    | integer, at least 1                    | 2         | The most repairs of each approach                    |

³ A model's family comes from its id after the last `/`: `anthropic` for `claude`, `opus`, `sonnet` and `haiku`,
`openai` for `gpt`, `o<digit>` and `codex`, `google` for `gemini`, `xai` for `grok`, `meta` for `llama`, `alibaba` for
`qwen`, and `mistral` and `deepseek` for their own names. Else it is the part before the first `/`, else the id. A
gateway prefix such as `github-copilot/` never decides it. A skeptic of the lens's family fails compose.
