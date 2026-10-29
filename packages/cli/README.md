# @maestro/cli

The `maestro` command: it builds, checks and performs compositions, and reads the record of what it performed.

```sh
maestro perform demo.greet --name world --tour release-2 --title "first try"
maestro ls --tour release-2
maestro wait <concert> --timeout 15m
```

## Commands

| Command                      | Alias | Does                                                                                                                             |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `compose <composition>`      | `c`   | Builds and pre-flights a composition. `--plan` (with each agent's profile, harness, model, thinking[^plan]), `--graph`, `--out`. |
| `perform <composition>`      | `p`   | Performs it as a concert in the foreground. `--tour`, `--title`.                                                                 |
| `perform --resume <concert>` | `p`   | Resumes a failed or rejected concert, reusing each `ok` instance still valid.[^resume]                                           |
| `ls [<concert>]`             |       | Lists concerts, or one concert's node instances. `--status`, `--composition`, `--tour`, `--workspace`, `--limit`.                |
| `wait <concert>`             | `wt`  | Waits for a concert to settle. `--timeout <duration>`.                                                                           |
| `watch <concert>`            | `w`   | Shows a concert's node instances live; on a terminal, a tree to browse until `q`.[^watch] `--events`.                            |
| `kill <concert>`             | `k`   | Stops a running concert and waits for it to settle.                                                                              |
| `repertoire [<pack>]`        | `rep` | Lists installed packs and their compositions, or one composition in full.[^rep]                                                  |
| `config <composition>`       | `cfg` | Shows the composed config, each value with its layer, file and line or `-c`.                                                     |
| `prune [<concert>...]`       |       | Deletes settled concerts, their files and what their hosts hold.[^prune]                                                         |
| `tour <slug> <concert>...`   | `t`   | Puts concerts on a tour. `--clear` takes them off.                                                                               |
| `changeset show <concert>`   | `cs`  | Prints a concert's changeset as a diff on its base, the checkout untouched.[^changeset] `--stat`, `--summary`, `--partial`.      |
| `changeset apply <concert>`  | `cs`  | Stages the changeset on the checkout's `HEAD` with `git apply --index --3way`, patch by patch. `--commit`, `--partial`.          |
| `changeset drop`             | `cs`  | Resets the checkout's tracked files. It asks first unless given `--yes`.                                                         |
| `artifact <concert>`         | `art` | Lists a concert's artifacts, or prints an instance's files raw.[^artifact] `--path`.                                             |

[^plan]:
    The `agents:` block lists each agent's node, profile, and the harness, model and thinking it resolves to, as
    `compose --json` does in `agents`.

[^watch]:
    On a terminal, the graph redrawn in place, or with `--events` one line per event, tool calls, result sizes and
    thinking among them: the time, the instance, a word for what happened and its detail, in aligned columns, a long
    detail wrapped under its column and a multi-line one cut to its first line. Off a terminal `--events` prints the
    same lines unwrapped and without color. The graph is a header (status, elapsed time and the short id), `now` and
    `last` lines naming the latest running and failed instances, the composition as authored with each loop at its
    latest round and each fan-out's items on one row, and a footer of counts and the concert's tokens. Rows that don't
    fit fold into count lines, and the footer then points at `maestro ls`. Ctrl-C stops watching, not the concert. With
    stdin a terminal too, the graph is a tree to browse: see [Browsing a concert](#browsing-a-concert).
    `--events --instance <id>` keeps only that instance's events, `<id>` as `ls <concert>` prints it, such as
    `lens[risk]/skeptic`, or a unique ending of whole segments of a node or scope id, such as `skeptic`; a group, loop,
    fan-out or scope id, without keys for every iteration, takes everything under it. An id the concert has no node for
    is a usage error.

[^changeset]:
    The checkout is `target.repo` from the concert's config: the config files with its recorded `--preset` and `-c`, as
    a resume layers them, then the command's own; `drop` takes no concert and uses the command's own config alone.
    `-C <repo>` is `-c target.repo=<repo>`, with a relative path taken from the current directory. The changeset is the
    result node's when it made one, else the last `ok` instance's that did; `--node <id>` names one, `<id>` as
    `ls <concert>` prints it or a unique ending of whole segments of one. `--partial` (with `--node`, else a usage
    error) takes the work a failed, blocked or cancelled agent kept, not a changeset; an instance with none is refused
    (exit 1). A concert that is not `ok` is warned of on stderr. `show` and `apply` exit 1 for a concert with no
    changeset or an empty one, or a checkout without its base (fetch it first); `apply` exits 1 on uncommitted tracked
    changes and 3 when a patch leaves conflicts. A flag the action does not take is a usage error, and so is `--json`:
    the output is the diff itself. Git runs with the user's own config, nothing is committed unless `apply --commit` is
    given, which commits the staged change with the changeset's message (exit 1, nothing staged, when it has none);
    otherwise commit with git or jj to stack the next one. `show` prints the message before the diff.

[^artifact]:
    Without an instance, a table of each artifact's instance, port, `stale` mark and absolute path (`--json`: a list of
    `{instance, port, path, contentHash}`, plus `stale: true` on a stale instance's). `art <concert> <instance>` prints
    the bytes of each file of the instance's artifacts as they are, each after a `══ <file>` line when there are
    several; `art <concert> <instance> <file>` prints one, so it pipes, such as
    `maestro art <concert> request request.md | glow -p`. A file is named by its artifact's basename plus any inner
    path, such as `staged/prompt.md`. `--path` prints absolute paths, one per line, instead. Printing a stale instance's
    files (one a resume left from an earlier attempt) adds a `warning:` line on stderr. An instance is any name
    `ls <concert>` prints, or a unique ending of whole segments of one, such as `build` for `loop[0]/build`. An unknown
    or ambiguous instance or file, and `--json` with an instance or `--path`, are usage errors; an instance with no
    artifacts yet, or an artifact gone from disk, exits 1. To read what an agent is told before any spend, perform a
    stub concert (`--preset stub`) and read its instance's `staged/instructions.md` and `staged/prompt.md`.

[^rep]:
    `rep <pack>.<composition>` shows its doc, each param as the flag to type with its type and default or `required`,
    the config entries its host nodes read by name when built from its example set (a `Config` line, `config` in
    `--json`), and a `maestro perform` line with the required flags. A pack that fails to load is named on stderr, the
    rest are listed, and the exit is 1.

[^resume]:
    It re-reads the config files, layers the concert's recorded `--preset` and `-c` on them, then the resume's own
    `--preset` and `-c`. The record store is found by today's `dataRoot`: a recorded `-c dataRoot=` changes the config
    only, so pass it again to resume a concert in another store. An error from a recorded flag names the concert, and is
    fixed by a `-c` or `--preset` on the resume, or by performing the composition as a new concert. It runs the graph
    recorded at first perform, so an edit adds or removes no node, but code nodes load from the file as it is now and
    their hash covers the whole bundle (ADR 0008): any edit to the composition file reruns every code node, and
    dependents rerun when their inputs changed. A changed code hash prints a warning on stderr and the resume goes on.
    After editing a composition, perform a new concert.

[^prune]:
    Names concerts, or picks settled concerts by `--before <duration>` (settled longer ago than that), `--tour <slug>`,
    `--workspace <name>`, `--status <status>` and `--composition <pack.name>`, as `ls` takes them; without `--before`
    there is no age cutoff, and `--status running` is refused. It asks before deleting unless given `--yes`.

`compose <composition> --help` and `perform <composition> --help` add the composition's params, as `rep` shows them.

`maestro --version` prints one line, `maestro <version> (sdk <version>, ir <version>, bun <version>)`, and exits 0.

Every command but `changeset` takes `--json` (one JSON document on stdout, and no `warning:` lines on stderr),
`--preset <name>`, `-c, --config <key=value>` (repeatable), `--no-color`, `--debug` (stack traces) and `--help`. Primary
output goes to stdout, messages to stderr.

Each stream is colored only when it is a terminal: stdout by its own check, stderr by its own. Color is off under
`NO_COLOR`, `TERM=dumb` or `--no-color`, and the `--json` document is never colored. It covers the `ls` status column,
the bold table headers of `ls`, `ls <concert>` and `art`, the closing block, the `watch` views, a diagnostic's code
(red, yellow for a warning) and its dim hint line, the dim hint line of an error, and `--help` (bold headings, cyan
flags, the Params block included).

`watch` replays from the concert's first event, then follows it. With `--json`, or off a terminal without `--events`, it
prints a JSON Lines stream: one compact line per record event that changes an instance's state (`running`, `settled`,
`reused`), or per event of any type with `--events --json`, each as the record holds it, ending with the concert
document, `wait --json`'s with `"type":"concert"`. Otherwise stdout holds the view, and the watch ends with the closing
block, as `wait` prints it after the graph, or only its `concert` row with `--events`.

### Browsing a concert

When stdin and stdout are both terminals, `watch <concert>` without `--events` or `--json` takes the alternate screen
and draws the graph as a tree to drive with keys. It follows by default: the cursor sits on the newest running instance,
or once the concert settles on the last `failed` one, with the containers leading to it open. A loop shows its latest
round unless `[` or `]` pins another, marked `(history)`. Under the tree, a line names the cursor row's instance, kind,
state, time and agent, then its reason or latest progress, and the last line the mode and keys.

| Key                     | Does                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `j` `↓` / `k` `↑`       | Moves the cursor down or up[^off]                                                            |
| `l` `→` / `h` `←`       | Opens a row, or steps to its first member / closes it, or steps to its container[^step]      |
| `space`                 | Opens or closes the row                                                                      |
| `[` / `]`               | The previous or next iteration of the `loop`, `map`, `find` or `fold` the cursor is in[^off] |
| `g` `Home` / `G` `End`  | The first or last row[^off]                                                                  |
| `PgUp` `u` / `PgDn` `d` | One viewport up or down[^off]                                                                |
| `e`                     | The last `failed` instance, its containers opened and its rounds shown[^off]                 |
| `f`                     | Toggles follow; turning it on drops the pinned rounds and keeps the folds                    |
| `Enter`                 | Inspects the row                                                                             |
| `q` `Ctrl-C`            | Quits                                                                                        |
| `Ctrl-Z`                | Gives the terminal back and suspends; `fg` resumes                                           |

[^off]: Turns follow off.

[^step]: A step turns follow off.

`Enter` replaces the tree with the row's part of the record, under the same header: a title, then for one instance its
context, state, start and run time, tokens, actor, a `stale` mark when an earlier attempt left it, and its reason or
latest progress, a `session` line with the path of an agent's session, where its harness writes the transcript, then its
metrics by name, wired inputs (a fan-out item, a loop round's carried value, a collected input; not literals), outputs,
artifacts and raw enrichment when the record has them. A group, scope or fan-out row counts every instance under it in
its round instead. Below come the events of what it shows, as `--events` words them, and new ones append while it runs.
The inspector tails the newest until a scroll moves away; `G` or scrolling back to the end tails again.

| Key                       | Does in the inspector   |
| ------------------------- | ----------------------- |
| `j` `↓` / `k` `↑`         | Scrolls one line        |
| `g` `Home` / `G` `End`    | The first event / tails |
| `PgUp` `u` / `PgDn` `d`   | One viewport up or down |
| `Esc` `Enter` `q` `h` `←` | Back to the tree        |
| `Ctrl-C`                  | Quits                   |

It stays open after the concert settles, and on a settled concert it opens straight into browsing. Quitting gives the
terminal back, then prints the graph with every row and the closing block, and exits with the concert's code, or 130
when it has not settled. A resize redraws. `SIGTERM`, `SIGHUP` and `SIGINT` give the terminal back before exiting with
128 plus the signal's number; after a `SIGKILL`, `reset` restores it.

### Debug

`watch <concert> --frames '<keys>'` prints the browsed graph, then a `── <key>` line and the graph again after each
space-separated key, named as typed (`j`, `[`) or as an input (`down`, `previous`, `enter`, `esc`), stopping at `q` on
the tree or `interrupt`. It needs no terminal and exits with the concert's code, or 0 while it runs. It is left out of
`--help`, and its output may change.

`ls <concert>` lists the node instances in graph order, every instance: subcompositions, groups and loop rounds nest,
and one node's expansions keep the order they started in. `ls <concert> --json` lists `instances` in that order, each
with `inputs`, the values a leaf was fed on its wired ports, left out when the record has none (a group, or an instance
from an older store).

Under its table, `ls <concert>` lists the notes its hosts give the current instances, such as an agent's `Obstacles` and
`Lessons`: each heading, then one `<instance>  <entry>` line per entry. On a terminal an entry wider than the screen is
cut with `…`, and a dim line then says how to read the full text; piped output is never cut. `--json` gives each
instance's `notes` by heading. `ls` marks a concert whose instances have notes with `•` after its status, and its
`--json` gives each concert's `notes` as a count by heading.

`ls --composition` takes `<pack>.<composition>`, such as `greet.hello`, and the list shows compositions the same way.

A concert's id is a UUIDv7, which the record, its paths, lane refs and every `--json` document hold; `ls --json` adds
the short id as `short` on each concert. `ls`, `watch`'s header and the closing block show its short id instead: the
UUID's last 15 hex digits written in jj's reverse-hex letters (`0` to `f` as `z` to `k`), 8 of them, more when 8 do not
tell it apart. Every `<concert>` is a prefix of either that no other concert's starts with, as in jj; a short id's
letters are no hex digit, so a prefix is never both. A prefix that several concerts start is a usage error (exit 2)
naming their short ids. On a terminal a short id shows the letters that tell it apart in bold and the rest dim.

Spend shows beside the status. An agent instance, in `ls <concert>` and `watch`, has an agent column,
`<harness> · <model> · <effort>  <total> tok`: the model without its provider (`github-copilot/claude-haiku-5.5` shows
as `claude-haiku-5.5`), the effort only when the profile sets `thinking`, the total the sum of the instance's `tokens_*`
metrics but `tokens_reasoning`, which output tokens already count, as `999`, `15.5k` or `1.2M`, left out when 0. A
running agent shows the harness, model and effort from the `agent` progress event it emits when it starts, then its
latest note. Other instances leave the column blank. The `ls` list has a `tokens` column with the concert's total, `-`
when it has none. In the `--json` documents of `ls` (each row, and `ls <concert>`), `wait` and `perform`, `metrics`
holds each metric name's total over the concert. `ls --json` rows and `ls <concert> --json` also carry `elapsedMs`,
`settledAt - startedAt`, or the time since `startedAt` while the concert runs.

`perform` announces `concert <id>`, the full id, on stderr when it starts. `perform`, `wait` and `watch` on a terminal
end with the closing block, its labels in one column:

```text
concert    pwmqwmlu  failed  13s · 29.7k tokens
at         repair_until_green/loop[0]/repair
reason     blocked: the failing check contradicts the spec
logs       ~/.local/share/maestro/concerts/01a154e0-0160-7590-ba3d-93de543f1059/artifacts/abuKV1B/check.log
```

Stderr carries the `concert` row, with the outcome, the elapsed time and the concert's tokens when it has any, then for
a concert that is not ok `at`, the instance it settled at, and `reason`, each control character shown as its escape.
Stdout holds a `<port>  <value>` line per output port of the result node, and nothing else. Each stream is styled only
when it is a terminal: on stderr the outcome is colored and the reason wraps under the value column, on stdout values
are colored and a path in the home directory starts with `~`. Piped or redirected, a stream has no color or wrapping,
values show as they are and paths are absolute. With `--json`, stdout holds the document instead, and the id of a
`perform` stays on its stderr line. A one-line string, a number, a boolean or `null` prints as is, anything else as
compact JSON, and an artifact as its path. A rejected concert shows its root cause's rejection outputs; a failed one has
none. In the `--json` document they are as stored, under `outputs`, and its other field names are the record's columns
in camelCase, with sizes in bytes.

A composition is a `.ts` or `.js` file that exports exactly one composition, a `.json` IR file, or
`<pack>.<composition>` of an installed pack. Its params are flags in kebab-case, layered over the config, and `compose`
fills the params neither gives from the composition's example set, an optional param only when they give none of the
optional ones; a boolean takes `--name` and `--no-name`. An IR file is already built and takes no param flags.

A file's stem is its pack id, so it must be one: lower case, starting with a letter, then letters, digits, `_` or `-`,
and no installed pack's. A bare file takes params from its flags, its example set and its defaults only. No config key
configures it; make it a pack for that.

## Config

Layers, lowest first: the defaults, `$XDG_CONFIG_HOME/maestro/config.yaml`, the nearest `.maestro/config.yaml`, the
preset `--preset <name>` names, then each `-c` in order. Maps merge by key and a list is replaced by the layer above it.
A tag changes that: `!replace` on a map, `!append` on a list, `!delete` to drop a key. `maestro config <composition>`
shows where each value came from.

A preset is `<name>.yaml` in the workspace's `.maestro/presets/`, else in `$XDG_CONFIG_HOME/maestro/presets/`; the
workspace's file wins the name whole. Relative paths in it resolve as in the config file beside it: the workspace root,
or the user config directory.

`-c <key>=<value>` sets one key, checked by the same schemas, and an error names the flag. The key is a dotted path,
with a key holding a `.` in double quotes; the value is YAML, so `=true` is a boolean, `=[a, b]` a list, and the tags
work:

```sh
maestro perform demo.greet --name x -c concurrency=2 -c 'packs=!append [../b]' -c target.checks.lint=!delete
maestro perform demo.greet --name x -c 'profiles.reviewer.runtime=!replace {harness: stub, model: none}' -c 'target.checks."a.b"=x'
```

A profile's fields resolve per field, highest first: `-c` and the preset, then the config files' `profiles`, then the
profile directory's `profile.yaml`. So `--preset stub` always means no spend, while
`-c profiles.builder.runtime.model=haiku` changes only the model. A composition sets none of them. A resume applies the
same order.

A concert's record keeps its `--preset` and each `-c` as typed, and `ls <concert> --json` shows them as `preset` and
`config`. Keep secrets out of `-c`: set them in `$XDG_CONFIG_HOME/maestro/.env`.

| Key           | Meaning                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `packs`       | Directories of installed packs, beside each directory under `$XDG_DATA_HOME/maestro/packs/`.           |
| `concurrency` | Most node instances at once in one concert. Defaults to the CPU count.                                 |
| `dataRoot`    | Where the record and the concerts' files live. Defaults to `$XDG_DATA_HOME/maestro`.                   |
| `workspace`   | The workspace name a concert records. Defaults to the name of the directory that holds `.maestro/`.    |
| `caps`        | Caps by name: `instances` caps a concert's node instances, any other name the total of a host count.   |
| `target`      | The repo host's `repo`, default `base`, `checks`, and per checked-out copy `prepare` and `sparse`.     |
| `profiles`    | The repo host's profiles by name: `runtime`, `limits`, `readOnly`, `attachments`, over `profile.yaml`. |
| `sandbox`     | The repo host's `readOnly` paths, bound into every agent, check and prepare.                           |

A relative `packs`, `dataRoot`, `target.repo` or other path key is relative to the workspace root, the directory that
holds `.maestro/`, in the workspace file, a workspace preset and a `-c`, and to the user config directory in the user
file and a user preset. A `-c` outside a workspace is relative to the cwd.

The repo host's namespaces are set out in architecture.md section 12, Configuration. Its Claude Code harness reads the
token from `CLAUDE_CODE_OAUTH_TOKEN`, set in the shell or in `$XDG_CONFIG_HOME/maestro/.env`; get one with
`claude setup-token`. maestro loads that `.env` when it exists, a variable the shell sets winning; the release binary
reads no `.env` or `bunfig.toml` from the cwd, while a run through `bun` from the repository still does.

The `stub` harness waits `MAESTRO_STUB_DELAY` before each agent turn settles, a duration such as `2s` or `500ms`; unset,
it answers at once.

`MAESTRO_STUB_OUTPUTS=<dir>` scripts what a stub agent delivers, per node instance. For each declared output it copies
`<dir>/<instance id>/<file>`, else `<dir>/<node id>/<file>`, else writes the placeholder; the instance id is as `ls`
prints it (`loop[0]/review`), the node id is it without the `[n]` indices and serves every round. A verdict agent's
outcome comes from a `verdict` file found the same way, holding `ok` or `rejected <reason>`; absent, `ok`. The host
validates a scripted file like any output. A dir that does not exist, or a `verdict` file of any other text, fails the
stub agent. Set it again on a resume.

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

A tour is a slug of one or more dot-separated segments, each lower-case words joined by hyphens, such as
`epic.story.task`, at most 64 characters. `--tour <slug>` on `ls` and `prune` matches that tour and every tour under it:
`epic` matches `epic` and `epic.story`, not `epic-x`. `perform` takes it from `--tour`, else `MAESTRO_TOUR`. A duration
is a positive whole number and one unit of `ms`, `s`, `m`, `h` or `d`, such as `500ms` or `7d`.

## Exit codes

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | Done, or the concert settled `ok`.                                                            |
| 1    | The concert settled `failed`, a command could not do what it was asked, or an internal error. |
| 2    | Usage error, or a composition that does not compose.                                          |
| 3    | The concert settled `rejected`, or a patch of `cs apply` left conflicts.                      |
| 124  | `wait --timeout` passed with the concert still running.                                       |

`watch` exits as `wait` does, except that browsing a concert quit before it settled exits 130 (Ctrl-C), 129 (hang-up) or
143 (SIGTERM).
