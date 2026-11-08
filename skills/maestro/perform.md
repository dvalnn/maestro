# Perform

Steps to perform a composition and read its result, then reference for `compose`, `perform` and the follow verbs. Every
verb but `cs` takes `--json`, `--preset <name>`, `-c <key>=<value>` (repeatable) and `--debug`; every other flag is in
`maestro <verb> --help`.

## Steps

1. **Find the workspace**: `.maestro/config.yaml` from the cwd up. None, or a runtime, target or check missing: follow
   [bootstrap.md](bootstrap.md). Done when `maestro compose <c>` reports no `CFG.*` or `HOST.*` diagnostic (codes show
   under `--json`); a runtime set only in a preset needs `--preset <name>` on that compose too.
2. **Pick the composition**: `<pack>.<composition>` of an installed pack, or a file. `maestro rep --json` lists each
   installed one with its doc, params, config entries and a `perform` line; `maestro rep <pack>.<composition>` shows
   one. Done when every required param has a value from a flag or the config.
3. **Pre-flight**: `maestro compose <c> [flags]`, with the flags perform will get. Done on exit 0. Before a perform on a
   paid harness, give the user the plan's `repo.agent` bound as the spend ceiling.
4. **Perform detached.** `perform` holds its terminal until the concert settles, and a signal to its process group
   cancels it. `--detach` runs it in a session of its own:

   ```sh
   maestro perform <c> [flags] --tour <slug> --title "<what for>" --detach
   ```

   Done when it exits 0 with the concert's id on stdout.

5. **Follow**: `maestro wait <id> --timeout 90s` in a loop, the timeout shorter than your tool call's own limit. Exit
   124 means still running: wait again. Done on any other exit. A user who wants to see it live runs
   `maestro watch <id>` in their own terminal.
6. **Read the result**: the exit code ([SKILL.md](SKILL.md), section Exit codes and outcomes), the closing block on
   stderr and the outputs on stdout (section Perform). On a `rejected` concert, read the root cause's `logs` file next.
   Done when the user has the outcome, the root cause instance and its reason when not `ok`, and the changeset
   ([changesets.md](changesets.md)).

## Compose

`maestro compose <c> [param flags]` builds the composition and pre-flights it, spending and writing nothing unless given
`--out`.

- `<c>` is `<pack>.<composition>`, a `.ts` or `.js` composition file, or a `.json` IR file.
- `maestro compose --concert <id> [--plan|--graph|--json]` shows the graph a concert was performed from, under today's
  config files with its recorded `--preset` and `-c`.
- Params are kebab-case flags: `maxRepairs` is `--max-repairs <value>`; a boolean is `--strict` or `--no-strict`. A
  param with no flag takes its value from config (a pack's only), then its default.
- Compose alone falls back on the composition's first example set for params no flag or config gives (an optional one
  only when no optional param is given), so it composes with no flags. Perform never does, and refuses a missing
  required param with `CFG.required`.
- Output: `<name>: <count> node instances, <count> repo.agent`, with `up to` where a group or loop bounds it.
  Diagnostics go to stderr as `<code>: <message>`, then the hint, which is the fix.
- `--plan` adds every node with its kind and count, and each agent's node, seat, profile, harness, model and thinking;
  `--json` carries the same as `agents`. `--graph` prints a Mermaid flowchart.
- `--out plan.json` saves the IR, a bare file's code beside it as `plan.bundle.js`. `maestro perform plan.json` performs
  exactly that IR, taking no param flags.

## Perform

`maestro perform <c> [param flags] [--tour <slug>] [--title <text>]` pre-flights, then performs the plan as a concert. A
perform that refuses prints why and exits non-zero.

- SIGINT or SIGTERM cancels the concert, which settles `failed`.
- Stderr: `concert <id>` once it starts; when it settles, a `concert <short id>  <outcome>  <elapsed>` row, then
  `at <instance>` and `reason <reason>` when not `ok`.
- Stdout, piped: one `<port>  <value>` line per result output. A scalar prints as is, any other value as compact JSON,
  an artifact as its absolute path. A `rejected` concert shows its root cause's outputs, such as a check's `logs` and
  `lane`; a `failed` one shows none.
- `--json`: `{ id, status, resultNode, resultExpansion, reason, outputs, metrics, tokens, artifacts }`. `artifacts` is
  the concert's artifact directory; an artifact output is `{ path, contentHash, producer }`, `path` relative to it.
- `--tour <slug>` (else `MAESTRO_TOUR`) puts the concert on a tour: dot-separated segments of lower-case words joined by
  hyphens, such as `epic.story`, at most 64 characters. `--title <text>` labels it in `ls`.

## Follow

An `<id>` is a concert's full id, its short id (8 letters from `k` to `z`, as `ls` shows it) or a prefix of either no
other concert's starts with.

- `maestro wait <id> --timeout <duration>` prints what `perform` prints once the concert settles and exits with its
  code; on the timeout it exits 124. A duration is a whole number and one unit: `500ms`, `90s`, `15m`, `12h`, `7d`.
- `maestro ls` lists concerts, newest first; `ls --help` lists its filters, such as `--status running` and `--tour`.
- `maestro watch <id>` piped prints JSON Lines, one per instance state change, ending with a `{"type":"concert",...}`
  line holding `wait --json`'s document. `--events` gives one line per event; `--events --instance <id>` keeps one
  instance's, or everything under a group or scope. It takes no timeout: bound it as `timeout 90s maestro watch <id>`.
