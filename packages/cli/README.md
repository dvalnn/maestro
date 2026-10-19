# @maestro/cli

The `maestro` command: it builds, checks and performs compositions, and reads the record of what it performed.

```sh
maestro perform demo.greet --name world --tour release-2 --title "first try"
maestro ls --tour release-2
maestro wait <concert> --timeout 15m
```

## Commands

| Command                      | Alias | Does                                                                                                              |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `compose <composition>`      | `c`   | Builds and pre-flights a composition. `--plan`, `--graph`, `--out <file>`.                                        |
| `perform <composition>`      | `p`   | Performs it as a concert in the foreground. `--tour`, `--title`.                                                  |
| `perform --resume <concert>` | `p`   | Resumes a failed or rejected concert, reusing each `ok` instance still valid.                                     |
| `ls [<concert>]`             |       | Lists concerts, or one concert's node instances. `--status`, `--composition`, `--tour`, `--workspace`, `--limit`. |
| `wait <concert>`             | `w`   | Waits for a concert to settle. `--timeout <duration>`.                                                            |
| `watch <concert>`            | `wt`  | Shows a concert's node instances live until it settles.[^watch] `--events`, `--no-color`.                         |
| `kill <concert>`             | `k`   | Stops a running concert and waits for it to settle.                                                               |
| `repertoire [<pack>]`        | `rep` | Lists installed packs and their compositions, or one composition in full.[^rep]                                   |
| `config <composition>`       | `cfg` | Shows the composed config, each value with its layer, file and line.                                              |
| `prune [<concert>...]`       |       | Deletes settled concerts, their files and what their hosts hold.[^prune]                                          |
| `tour <slug> <concert>...`   | `t`   | Puts concerts on a tour. `--clear` takes them off.                                                                |

[^watch]:
    On a terminal, the graph redrawn in place, or with `--events` one line per event, tool calls and thinking among
    them: the time, the instance, a word for what happened and its detail, in aligned columns, a long detail wrapped
    under its column and a multi-line one cut to its first line. Off a terminal `--events` prints the same lines
    unwrapped and without color. The graph is a header (status, elapsed time and the short id), the rows by
    subcomposition and loop round, and a footer of counts and the concert's tokens. Ctrl-C stops watching, not the
    concert. Color is off under `NO_COLOR`, `TERM=dumb` or `--no-color`.

[^rep]:
    `rep <pack>.<composition>` shows its doc, each param as the flag to type with its type and default or `required`,
    the config entries its host nodes read by name when built from its example set (a `Config` line, `config` in
    `--json`), and a `maestro perform` line with the required flags. A pack that fails to load is named on stderr, the
    rest are listed, and the exit is 1.

[^prune]:
    Names concerts, or picks settled concerts by `--before <duration>` (settled longer ago than that), `--tour <slug>`
    and `--workspace <name>`; without `--before` there is no age cutoff. It asks before deleting unless given `--yes`.

`compose <composition> --help` and `perform <composition> --help` add the composition's params, as `rep` shows them.

`maestro --version` prints one line, `maestro <version> (sdk <version>, ir <version>, bun <version>)`, and exits 0.

Every command takes `--json` (one JSON document on stdout), `--profile <name>`, `--debug` (stack traces) and `--help`.
Primary output goes to stdout, messages to stderr.

`watch` replays from the concert's first event, then follows it. With `--json`, or off a terminal without `--events`, it
prints a JSON Lines stream: one compact line per record event that changes an instance's state (`running`, `settled`,
`reused`), or per event of any type with `--events --json`, each as the record holds it, ending with the concert
document, `wait --json`'s with `"type":"concert"`. Otherwise stderr carries the closing line, and stdout holds only the
view.

`ls --composition` takes `<pack>.<composition>`, such as `greet.hello`, and the list shows compositions the same way.

Every `<concert>` is an id or any prefix of one that no other concert's id starts with, as in jj. A prefix that several
ids start is a usage error (exit 2) naming them. On a terminal, `ls` shows each id with the characters that tell it
apart in bold and the rest dim.

Spend shows beside the status. An agent instance, in `ls <concert>` and `watch`, has an agent column,
`<harness> · <model> · <effort>  <total> tok`: the model without its provider (`github-copilot/claude-haiku-5.5` shows
as `claude-haiku-5.5`), the effort only when the role sets `thinking`, the total the sum of the instance's `tokens_*`
metrics but `tokens_reasoning`, which output tokens already count, as `999`, `15.5k` or `1.2M`, left out when 0. A
running agent shows the harness, model and effort from the `agent` progress event it emits when it starts, then its
latest note. Other instances leave the column blank. The `ls` list has a `tokens` column with the concert's total, `-`
when it has none. In the `--json` documents of `ls` (each row), `wait` and `perform`, `metrics` holds each metric name's
total over the concert.

`perform` and `wait` print one `name  value` line per output port of the result node on stdout, and nothing else there.
Stderr carries `concert <id>` when a `perform` starts and the closing line
`concert <id> <outcome>[ at <node>][: <reason>]`. With `--json`, stdout holds the document instead, and the id of a
`perform` stays on its stderr line. A one-line string, a number, a boolean or `null` prints as is, anything else as
compact JSON, and an artifact as its path. A rejected concert shows its root cause's rejection outputs; a failed one has
none. In the `--json` document they are as stored, under `outputs`, and its other field names are the record's columns
in camelCase, with sizes in bytes.

A composition is a `.ts` or `.js` file that exports exactly one composition, a `.json` IR file, or
`<pack>.<composition>` of an installed pack. Its params are flags in kebab-case, layered over the config, and `compose`
fills the params neither gives from the composition's example set; a boolean takes `--name` and `--no-name`. An IR file
is already built and takes no param flags.

A file's stem is its pack id, so it must be one: lower case, starting with a letter, then letters, digits, `_` or `-`,
and no installed pack's. A bare file takes params from its flags, its example set and its defaults only. No config key
configures it; make it a pack for that.

## Config

Layers, lowest first: the defaults, `$XDG_CONFIG_HOME/maestro/config.yaml`, the nearest `.maestro/config.yaml`, and
`.maestro/profiles/<name>.yaml` for `--profile`. Maps merge by key and a list is replaced by the layer above it. A tag
changes that: `!replace` on a map, `!append` on a list, `!delete` to drop a key. `maestro config <composition>` shows
where each value came from.

| Key           | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `packs`       | Directories of installed packs, beside each directory under `$XDG_DATA_HOME/maestro/packs/`.         |
| `concurrency` | Most node instances at once in one concert. Defaults to the CPU count.                               |
| `dataRoot`    | Where the record and the concerts' files live. Defaults to `$XDG_DATA_HOME/maestro`.                 |
| `workspace`   | The workspace name a concert records. Defaults to the name of the directory that holds `.maestro/`.  |
| `caps`        | Caps by name: `instances` caps a concert's node instances, any other name the total of a host count. |
| `target`      | The repo host's `repo`, default `base`, `checks`, and per checked-out copy `prepare` and `sparse`.   |
| `roles`       | The repo host's roles: a `harness`, `model` and optional `thinking` each.                            |
| `sandbox`     | The repo host's `readOnly` paths, bound into every agent, check and prepare.                         |

A relative `packs`, `dataRoot`, `target.repo` or other path key is relative to the workspace root, the directory that
holds `.maestro/`, in a workspace or profile file, and to the user file's own directory in the user file.

The repo host's namespaces are set out in architecture.md section 12, Configuration. Its Claude Code harness reads the
token from `CLAUDE_CODE_OAUTH_TOKEN`, set in the shell or in `$XDG_CONFIG_HOME/maestro/.env`; get one with
`claude setup-token`. maestro loads that `.env` when it exists, a variable the shell sets winning; the release binary
reads no `.env` or `bunfig.toml` from the cwd, while a run through `bun` from the repository still does.

A pack is operator-trusted code: `maestro` loads and executes what `packs` lists, and every directory under
`$XDG_DATA_HOME/maestro/packs/`, with the user's own permissions.

## Data root

| Path                      | Holds                                                       |
| ------------------------- | ----------------------------------------------------------- |
| `record.db`               | The record of concerts, node instances and events (SQLite). |
| `concerts/<id>/`          | One concert's artifact area and scratch directories.        |
| `hosts/repo/<target id>/` | The repo host's lanes, versions and sessions, per target.   |

`compose --out <file>` of a bare file writes its code as `<file stem>.bundle.js` beside the IR, so the IR loads on its
own. A pack's modules are made relative to the IR.

## Tours, titles, durations

A tour is a slug of lower-case words joined by hyphens, at most 64 characters. `perform` takes it from `--tour`, else
`MAESTRO_TOUR`. A duration is a positive whole number and one unit of `ms`, `s`, `m`, `h` or `d`, such as `500ms` or
`7d`.

## Exit codes

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | Done, or the concert settled `ok`.                                                            |
| 1    | The concert settled `failed`, a command could not do what it was asked, or an internal error. |
| 2    | Usage error, or a composition that does not compose.                                          |
| 3    | The concert settled `rejected`.                                                               |
| 124  | `wait --timeout` passed with the concert still running.                                       |

`watch` exits as `wait` does.
