# Profiles

A profile is a named agent setup. A composition sets no model: a seat names a profile, and config gives the profile its
runtime.

## Runtime

| Harness  | `model`                                          | `thinking`             |
| -------- | ------------------------------------------------ | ---------------------- |
| `claude` | an alias such as `sonnet`, or a full model id    | passed as `--effort`   |
| `pi`     | `provider/model`, such as `anthropic/claude-...` | passed as `--thinking` |
| `stub`   | any string; `none` by convention                 | ignored                |

maestro passes model and thinking through unchecked: confirm an id with the harness's own CLI. Per field, `-c` and
`--preset` beat the config files' `profiles`, which beat the profile's own `profile.yaml`, so `--preset stub` always
means no spend.

## Where a profile lives

A directory holding a `profile.yaml` (`runtime`, `instructions`, `limits`, `context`, `attachments`) and the files it
names, in one of these roots, highest first; the highest holding the name wins it whole:

- the workspace's `.maestro/profiles/<name>/`
- the user's `$XDG_CONFIG_HOME/maestro/profiles/<name>/`
- a pack's `profiles/`, named `<pack>/<name>`

`readOnly` is set only in config, as `profiles.<name>.readOnly`.

## Inspect

- `maestro agent ls`: every profile and the root that wins it.
- `maestro agent show <profile>`: what it resolves to, naming the layer behind each configured value.
- `maestro agent probe <profile>`: starts its harness and checks what it loads; see Probe below.
- `maestro agent show --seat <composition id>/<seat> <composition>`: the profile a seat is bound to, `seats:` first;
  `--prompt` prints the system prompt its agents get.
- `maestro agent show --concert <id> <node>`: what an agent of a concert recorded.

## Probe

`maestro agent probe <profile>` starts the harness as a concert would, stops once it reports its environment and its
model's context window, marks each part `✓`, `✗` or `?` (not reported), and exits 1 on a fault. It spends a startup, and
on claude one short turn: with a real harness, probe only on the user's go.

The window found is kept, and every agent turn refreshes it. A profile's `context.at` may then be a share of it, such as
`"50%"`. Pre-flight refuses a percentage, and pi's `compact`, for a model whose window is not kept: probe once, or write
`at` in tokens.
