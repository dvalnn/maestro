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

A directory holding a `profile.yaml` (`runtime`, `instructions`, `harnessExtras`, `limits`, `context`, `attachments`)
and the files it names, in one of these roots, highest first; the highest holding the name wins it whole:

- the workspace's `.maestro/profiles/<name>/`
- the user's `$XDG_CONFIG_HOME/maestro/profiles/<name>/`
- a pack's `profiles/`, named `<pack>/<name>`

A profile's paths may leave its directory but stay inside its namespace directory, the directory holding it
(`<root>/profiles/`, or `<root>/profiles/<pack>/` for a pack's name shadowed in a root), so profiles of one level can
share a file such as an attachment. Copy a pack's whole `profiles/` to shadow it and its paths keep working.

`readOnly` is set only in config, as `profiles.<name>.readOnly`.

`instructions` is a file or a list of files inside the namespace directory, joined in order into the system prompt, so
seats of one namespace share a file: `instructions: [../testing.md, instructions.md]`. Guidance a seat follows goes
there, never in an attachment. `skills` is no profile field, and a profile setting it is refused.

`harnessExtras` names one directory, in the harness's own layout, that the harness adapter copies into the config dir it
owns for the session, such as a provider catalogue. Keep it self-contained: each link in it relative and resolving
inside it, with no `node_modules` above it. pi takes extras: `models.json` is its model catalogue, and each script in
`extensions/` (or directory there with an index script) loads as an extension, in name order. pi refuses an entry named
`auth.json` or `settings.json`, which it writes itself. An extension may replace a built-in tool such as `read`: the
extras are your opt-in code and the sandbox stays the one boundary. pi drops an extension's own tools, so extras bring
providers, catalogues and hooks. claude takes extras too, refusing no entry: `settings.json` is its settings file, with
any hooks in it, and each plugin is a directory under `plugins/`. Its named tools, strict MCP config and slash commands
off still hold, so extras bring settings, hooks and plugin hooks, never a tool, skill or MCP server. A harness that
takes no extras refuses the field at pre-flight; `agent show` lists the directory's entries.

## Inspect

- `maestro agent ls`: every profile and the root that wins it.
- `maestro agent show <profile>`: what it resolves to, naming the layer behind each configured value. A harness or model
  nothing sets shows `-`, with the fix on stderr, and exits 0.
- `maestro agent probe <profile>`: starts its harness and checks what it loads; see Probe below.
- `maestro agent prompt <composition> <node>`: the system prompt the node gets, and on stderr the seat and profile it is
  bound to; `compose` lists each agent's seat.
- `maestro ls <concert>`: the faults an agent's environment report recorded, under `Environment`.

## Probe

`maestro agent probe <profile>` starts the harness as a concert would, stops once it reports its environment and its
model's context window, marks each part `✓`, `✗` or `?` (not reported), and exits 1 on a fault. It spends a startup, and
on claude one short turn: with a real harness, probe only on the user's go.

The window found is kept, and every agent turn refreshes it. A profile's `context.at` may then be a share of it, such as
`"50%"`. Pre-flight refuses a percentage, and pi's `compact`, for a model whose window is not kept: probe once, or write
`at` in tokens.
