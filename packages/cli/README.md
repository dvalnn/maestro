# @maestro/cli

The `maestro` command: it builds, checks and performs compositions, and reads the record of what it performed. Read it
for what the help cannot say: the behaviour behind a verb, its gotchas and its output formats. Commands, flags, aliases
and exit codes are in `maestro --help` and `maestro <command> --help`.

```sh
maestro perform demo.greet --name world --tour release-2 --title "first try"
maestro ls --tour release-2
maestro wait <concert> --timeout 15m
```

## Conventions

- `maestro --version` prints `maestro <v> (sdk <v>, ir <v>, bun <v>)` and exits 0.
- The common flags may come before the command, as in `maestro --preset stub compose <composition>`. A mistyped command
  or flag is met with `Did you mean '<name>'?`.
- Every command but `changeset` takes `--json`: one JSON document on stdout, no `warning:` lines on stderr, never
  colored. Primary output goes to stdout, messages to stderr. An unexpected error prints `error: unexpected:` and
  exits 1.
- `compose <composition> --help` and `perform <composition> --help` add the composition's params.

### Compositions and params

A composition is a `.ts` or `.js` file that exports exactly one composition, a `.json` IR file, or
`<pack>.<composition>` of an installed pack. Its params are flags in kebab-case, layered over the config; `compose`
fills the params neither gives from the composition's example set, an optional param only when they give none of the
optional ones. A boolean takes `--name` and `--no-name`.

- A root `File`, `Markdown` or `JsonFile` param takes a path: a flag's relative to the working directory, a config
  value's as other config paths are (see [Config](#config)). A `JsonFile` that is not JSON is refused. The record keeps
  a flag's path absolute.
- A new concert stages a copy of the file, which a resume keeps; an encore reads and hashes it anew.
- An IR file is already built and takes no param flags. `perform` refuses one that holds a file param's file: perform
  its composition file instead.
- `compose --out <file>` of a bare file writes its code as `<file stem>.bundle.js` beside the IR, so the IR loads on its
  own. A pack's modules are made relative to the IR.
- `compose --plan` lists each agent in an `agents:` table: its node, its `seat` (`<pack>/<composition>/<seat>`, the key
  a `seats` entry rebinds), its profile and the harness, model and thinking it resolves to, as `compose --json` does in
  `agents`. [render-text](../render-text/README.md) holds the drawing rules of `--flow`, which sets `--graph`.
- `compose --concert <id>` pre-flights the graph the concert recorded in place of a composition, under the config files
  as they stand layered with its recorded presets and `-c`, then the compose's own, as `resume` does. It takes no
  composition and no param flags: the recorded graph holds them. `--out` saves that graph as an IR file.

The file rules (stem, bare-file params, imports) are in [SDK spec: File rules](../../docs/sdk-spec.md#file-rules).

### Concert ids

A concert's id is a UUIDv7, which the record, its paths, lane refs and every `--json` document hold; `ls --json` adds
the short id as `short`. `ls`, `watch`'s header and the closing block show the short id instead; `perform`, `--detach`
and `prune -n` print the full id. The short id is the UUID's last 15 hex digits written in jj's reverse-hex letters (`0`
to `f` as `z` to `k`), 8 of them, more when 8 do not tell it apart.

Every `<concert>` is a prefix of either form that no other concert's starts with, as in jj; a short id's letters are no
hex digit, so a prefix is never both. A prefix that several concerts start is a usage error (exit 2) naming their short
ids. On a terminal a short id shows the letters that tell it apart in bold.

An `<instance>` or `--node` is any id `ls <concert>` prints, such as `lens[risk]/skeptic`, or a unique ending of whole
segments of a node or scope id, such as `skeptic`.

### Tours and durations

A tour is a slug of one or more dot-separated segments, each lower-case words joined by hyphens, such as
`epic.story.task`, at most 64 characters. `--tour <slug>` on `ls` and `prune` matches that tour and every tour under it:
`epic` matches `epic` and `epic.story`, not `epic-x`. A duration is a positive whole number and one unit of `ms`, `s`,
`m`, `h` or `d`, such as `500ms` or `7d`.

### Color and paging

Each stream is colored when it is a terminal, stdout and stderr by their own check. `--color` or a non-empty
`FORCE_COLOR` colors both; `NO_COLOR`, `TERM=dumb` and `--no-color` win over both. Color covers the `ls` status column
and table headers, the closing block, the `watch` views, the `error:` and `warning:` labels with their dim hint lines (a
diagnostic's code shows only under `--json`), and `--help`.

When `TERM` is set and not `dumb`, a command that prints a finished document and nothing after it pages it on a
terminal, as `git` does, but not under `--json`. `perform`, `resume`, `encore`, `wait`, `watch`, `kill`, `prune`,
`tour`, `agent ls`, and `changeset apply` and `drop` are never paged: they stream progress, ask, or print a line after
their output. The pager is `$PAGER` run as a shell command; `LESS` is `FRX` for it unless you set it. When it cannot
start, output goes straight through; when the shell cannot find it (exit 127), maestro names `PAGER` on stderr and
prints the output as it is, the exit code staying the command's. A pipe is never paged, so
`maestro art show <concert> <instance> review.md | glow -p` works. While the pager is open, Ctrl-C goes to it.

## Performing

`perform` announces `concert <id>`, the full id, on stderr when it starts, and on a terminal adds
`Follow it: maestro watch <id>`. It takes the tour from `--tour`, else `MAESTRO_TOUR`.

With `--detach`, `perform`, `encore` and `resume` run the concert in a process of its own session and exit 0 once it
starts, printing its id on stdout, or under `--json` `{"id": <id>, "status": "running"}`. A run that starts no concert
within 2 minutes is stopped; a run that refuses passes its output and exit code through. A concert stopped by Ctrl-C
(130) or SIGTERM (143) can be resumed. `kill` stops a running concert and waits for it to settle. `kill` of a concert
that already settled exits 0 and says `concert <id> already settled <status>` on stderr; `--json` prints the concert's
result document, as it does for one just stopped.

### The closing block

`perform`, `wait` and `watch` on a terminal end with the closing block, its labels in one column:

```text
concert    pwmqwmlu  ok  4m12s · 182.4k tok
verdict    object, 7 keys
report     text, 312 lines
status     ready
changes    3 files  +120 −14
Full outputs: maestro wait pwmqwmlu --json | jq .outputs
```

Stderr carries the `concert` row, then for a concert that is not ok `at`, the instance it settled at, and `reason`, each
control character shown as its escape. On a terminal the hint, and `changes` when there is one, follow even with no
outputs:

```text
concert    pwmqwmlu  failed  13s · 29.7k tok
at         repair_until_green/loop[0]/repair
reason     blocked: the failing check contradicts the spec
logs       ~/.local/share/maestro/concerts/01a154e0-0160-7590-ba3d-93de543f1059/artifacts/abuKV1B/check.log
maestro ls pwmqwmlu --json
```

Stdout holds a row per output port of the result node.

- On a terminal a value shows when it is one line and fits the columns after the label. Any other shows as its shape and
  size: `text, 312 lines` (`text, 80 chars` for one overlong line), `object, 7 keys` or `list, 12 items`. An artifact
  stays its path.
- `changes` follows when the concert holds a changeset whose diff can be read, `3 files  +120 −14` as
  `changeset show --stat` counts them. Then a dim hint, `maestro ls <concert> --json`, or `Full outputs: ...` when a
  value shows as its shape.
- Piped or redirected, stdout is a `<port>  <value>` line per output and nothing else, with no color or wrapping, values
  as they are and paths absolute. On a terminal a path in the home directory starts with `~`.
- With `--json`, stdout holds the document instead, and the id of a `perform` stays on its stderr line. A one-line
  string, a number, a boolean or `null` prints as is, anything else as compact JSON, and an artifact as its path.

A rejected concert shows its root cause's rejection outputs; a failed one has none. In the `--json` document they are as
stored, under `outputs`, an artifact's `path` relative to `artifacts`; its other field names are the record's columns in
camelCase, with sizes in bytes.

### Resume and encore

`resume` reuses each `ok` instance still valid.

- It re-reads the config files, layers the concert's recorded presets and `-c` on them, in order, then the resume's own
  `--preset` and `-c`. An error from a recorded flag names the concert; fix it with a `-c` or `--preset` on the resume,
  or perform the composition as a new concert.
- The record store is found by today's `dataRoot`: a recorded `-c dataRoot=` changes the config only, so pass it again
  to resume a concert in another store.
- It runs the graph recorded at first perform, so an edit adds or removes no node. Code nodes load from the file as it
  is now and their hash covers the whole bundle (ADR 0008): any edit to the composition file reruns every code node, and
  dependents rerun when their inputs changed. A changed code hash prints a warning on stderr and the resume goes on.
  After editing a composition, perform a new concert.

`encore` takes `--tour` and `--title`, and no composition.

- It builds the concert's composition anew with the param flags it was performed with, the encore's own overriding them,
  under the config files as they stand, the concert's recorded `-c` and the encore's own on top. The encore's presets
  replace the concert's whole list when it gives any.
- Every node runs again, and an agent continues its counterpart's session, unless its seat says `encore: false`. An
  agent that starts fresh says why in its `encoreFresh`, shown by `ls <concert> --json`. An encore of an encore matches
  against the encore.
- When the params, the config and the target revision all match the concert's, the encore is refused, naming `resume`.

## Listing and watching

### Listing

`ls <concert>` lists the node instances in graph order, every instance: subcompositions, groups and loop rounds nest,
and one node's expansions keep the order they started in. `ls --composition` takes `<pack>.<composition>`, such as
`greet.hello`, and the list shows compositions the same way. It lists the newest 20 by default; on a terminal, when the
limit leaves older concerts out, a dim line names the command that shows more, such as
`Older concerts: maestro ls --limit 40`, carrying the filters given. Piped output never has it.

- **Spend.** An agent instance has an agent column, `<harness> · <model> · <effort>  <total> tok`, in `ls <concert>` and
  `watch`: the model without its provider (`github-copilot/claude-haiku-5.5` shows as `claude-haiku-5.5`), the effort
  only when the profile sets `thinking`, and the total as `999`, `15.5k` or `1.2M`, left out when 0. The total sums the
  instance's `tokens_*` metrics but `tokens_reasoning`, which output tokens already count. A running agent shows them
  from the `agent` progress event it emits when it starts, then its latest note.
- **Concert list.** A `time` column after `status`, and a `tokens` column with the concert's total, `-` when it has
  none. The `disk` column, and the size `prune` frees, come from the record, measured as the concert settled; a running
  concert, or one the record holds no size for, is measured as `ls` runs, and the size kept once it settled.
- **Notes.** `ls` marks a concert whose instances have notes with `•` after its status, and its `--json` gives each
  concert's `notes` as a count by heading. Under its table, `ls <concert>` lists the notes its hosts give the current
  instances, such as an agent's `Obstacles` and `Lessons`, one `<instance>  <entry>` line each under its heading. On a
  terminal an entry wider than the screen is cut with `…` and a dim line says how to read the full reports; piped output
  is never cut.

`ls <concert> <instance>` lists that instance alone, its row and notes. Name it as `ls <concert>` lists it, or by a
unique ending of whole segments, such as `build` for `loop[0]/build`; a name that matches none, or several, is a usage
error. With `--json`, `instances` and `reports` hold that instance alone.

In the `--json` documents:

- `ls <concert> --json` lists `instances` in graph order, each with `inputs`, the values a leaf was fed on its wired
  ports, left out when the record has none (a group, or an instance from an older store).
- It gives the full report of each current instance that has one as `reports`, by the instance's name:
  `maestro ls <concert> --json | jq .reports`. An agent's report holds `summary`, `gaps`, `obstacles`, `lessons` and
  `sightings`; `maestro ls --help` says what each means.
- It gives the typed values of each current instance as `outputs`, by the instance's name, in the same shape:
  `maestro ls <concert> --json | jq .outputs`. They are an agent's reply fields and a code node's values, without
  artifacts, the report and the host's bookkeeping ports (an agent's `session` and `lane`); an instance with none is
  left out. `instances[].outputs` keeps every output as recorded.
- `ls` (each row), `ls <concert>`, `wait`, `watch` and `perform` carry `metrics`, each metric name's total over the
  concert, and `tokens`, the concert's total as the `tokens` column counts it. `ls` rows and `ls <concert>` also carry
  `elapsedMs`, `settledAt - startedAt`, or the time since `startedAt` while the concert runs.
- `ls <concert> --json` shows the recorded `--preset` list and `-c` flags as `presets` and `config`, and the concert's
  limits as `limits`, `timeout` in milliseconds.

### Watching

`watch` replays from the concert's first event, then follows it. Ctrl-C stops watching, not the concert. It exits as
`wait` does, except that browsing a concert quit before it settles exits 130 (Ctrl-C), 129 (hang-up) or 143 (SIGTERM).

- **Graph.** On a terminal, the graph redrawn in place: a header (status, elapsed time and short id), `now` and `last`
  lines naming the latest running and failed instances, the composition as authored with each loop at its latest round
  and each fan-out's items on one row, and a footer of counts and the concert's tokens. Rows that don't fit fold into
  count lines, and the footer then points at `maestro ls`. With stdin a terminal too, the graph is a tree to browse: see
  [Browsing a concert](#browsing-a-concert).
- **Events.** `--events` prints one line per event, tool calls, results with their sizes and `ok` or `error`, and the
  agent's context total and thinking, token counts in `k` and `M`, among them: the time, the instance, a word for what
  happened and its detail, a multi-line detail cut to its first line. The host words a model call's usage on its
  `context` line, as in `context 44.7k · in 2 · out 683 · cache 44.7k`; a usage with no prompt size beside it, such as
  claude's closing tally, stays a `usage` line. Off a terminal the lines are unwrapped and uncolored.
- **`--instance <id>`** keeps only that instance's events. A group, loop, fan-out or scope id, without keys for every
  iteration, takes everything under it. An id the concert has no node for is a usage error.
- **JSON.** With `--json`, or off a terminal without `--events`, `watch` prints a JSON Lines stream: one compact line
  per record event that changes an instance's state (`running`, `settled`, `reused`), or per event of any type with
  `--events --json`, each as the record holds it, ending with the concert document, `wait --json`'s with
  `"type":"concert"`.
- Otherwise stdout holds the view, and the watch ends with the closing block, as `wait` prints it after the graph, or
  only its `concert` row with `--events`.

### Browsing a concert

When stdin and stdout are both terminals, `watch <concert>` without `--events` or `--json` takes the alternate screen
and draws the graph as a tree to drive with keys. It follows by default: the cursor sits on the newest running instance,
or once the concert settles on the last `failed` one, with the containers leading to it open. A loop shows its latest
round unless `[` or `]` pins another, marked `(history)`. Under the tree, a line names the cursor row's instance, kind,
state, time and agent, then its reason or latest progress, never a result, usage or context line, and the last line the
mode and keys.

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

`Enter` replaces the tree with the row's part of the record, under the same header: for one instance its context, state,
times, tokens, actor, a `stale` mark when an earlier attempt left it, its reason or latest progress and its metrics,
and, when it has artifacts, a `files` line naming the `maestro art` that serves them. A group, scope or fan-out row
counts every instance under it in its round instead. Below come the events of what it shows, as `--events` words them,
and new ones append while it runs. The inspector tails the newest until a scroll moves away; `G` or scrolling back to
the end tails again.

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

`watch <concert> --frames '<keys>'` is a debug aid, left out of `--help`, and its output may change. It prints the
browsed graph, then a `── <key>` line and the graph again after each space-separated key (`j`, `[`, or `down`,
`previous`, `enter`, `esc`), stopping at `q` on the tree or `interrupt`. It needs no terminal and exits with the
concert's code, or 0 while it runs.

## Reading what a concert left

### Artifacts

- `ls --json` is a list of `{instance, port, path, contentHash}`, plus `stale: true` on a stale instance's.
- `show <concert> <instance>` prints the bytes of each file as they are (a `.patch` or `.diff` file colored like
  `git diff` when color is on), each after a `══ <file>` line when there are several. A file is named by its artifact's
  basename plus any inner path, such as `staged/prompt.md`; naming one prints only it, so it pipes.
- Printing a stale instance's files (one a resume left from an earlier attempt) adds a `warning:` line on stderr.
- An unknown or ambiguous instance or file, and `--json` with `show` or `--path`, are usage errors. An instance with no
  artifacts yet, or an artifact gone from disk, exits 1.
- To read what an agent is told before any spend, perform a stub concert (`--preset stub`) and read its instance's
  `staged/instructions.md` and `staged/prompt.md`.

### Changesets

The checkout is `target.repo` from the concert's config, layered as a resume layers it, then the command's own; `drop`
takes no concert and uses the command's own config alone. `show` leaves the checkout untouched, `apply` stages on its
`HEAD` and `drop` resets its tracked files. `-C <repo>` is `-c target.repo=<repo>`.

- The changeset is the result node's when it made one, else the last `ok` instance's that did; `--node <id>` names one.
  A concert that is not `ok` is warned of on stderr.
- `--partial` (with `--node`, else a usage error) takes the work a failed, blocked or cancelled agent kept, not a
  changeset; an instance with none is refused (exit 1).
- `show` prints the changeset message before the diff. `apply` stages patch by patch with `git apply --index --3way`.
- `show` and `apply` exit 1 for a concert with no changeset or an empty one, or a checkout without its base (fetch it
  first). `apply` exits 1 on uncommitted tracked changes and 3 when a patch leaves conflicts.
- A flag the action does not take is a usage error, and so is `--json`: the output is the diff itself.
- Git runs with the user's own config. Nothing is committed unless `apply --commit` is given, which commits with the
  changeset's message (exit 1, nothing staged, when it has none); otherwise commit with git or jj to stack the next one.

### Agent profiles

`agent ls` lists a profile that does not resolve too, with its error under its row, and shows a harness set without a
model. An unknown profile is a usage error naming the nearest one.

`agent show <profile>` prints the profile's sections at one column. A profile whose harness or model is unset shows `-`
for each, says its Environment has `no harness to declare one`, ends with the fix on stderr, naming the presets that set
them when any does, and exits 0.

- A value names its layer in brackets (`[preset high]`, `[-c]`, `[user config]`, `[workspace config]`) only when a layer
  above its `profile.yaml` set it, and each attachment shows the host path and where the agent sees it.
- A profile that sets `harnessExtras` shows an `Extras` section after `Instructions`: the directory with its source, and
  its top-level entries. The directory is self-contained, each link in it relative and inside it; the
  [host-repo README](../host-repo/README.md#fields) holds the rule.
- The environment is what the profile's harness adapter launches with: tools, subagents, skills, MCP servers, hooks,
  context files and compaction. It is the adapter's baseline, which a profile's harness extras may extend.
- `--json` gives the same fields with absolute paths, each value's source as its layer with its file and line or its
  `-c` flag, as `config --json` does.
- `agent prompt <composition> <node>` prints the system prompt of an agent node as the agent reads it, without
  performing: the same text as the instance's `staged/instructions.md`. The seat and profile the node is bound to go on
  stderr, with the layer that rebound the seat, if any. With `--json` it prints `{node, seat, prompt}`. A node that is
  no agent node is a usage error naming the nearest one. A profile with no harness or model still gives its prompt.
- `agent probe <profile>` first runs pre-flight's `harnessExtras` checks, failing with the first finding before the
  harness starts; the rest of pre-flight is skipped, so a window none is known for is no refusal. It then starts the
  harness as a concert would (the same sandbox, flags, instructions, attachments and extras, an empty scratch lane, no
  checks), stops it once it has reported its environment and its model's context window, failing after 60s without a
  report or with the run's reason when the run fails on its own, and lists the extras entries above its Environment
  section. It checks each part: `✓` matched, `✗` a fault with its detail under the row, `?` not reported. The fault
  count comes last, and a fault exits 1. A profile with no harness is a usage error naming the fix. Context shows the
  window with `kept for <harness> <model>`, and `show` points at `agent probe` with the `--preset` and `-c` flags it was
  given. `--json` adds `environment.observed` and `environment.checks`.
- Claude reports its environment through its `system/init` line and its window on its closing `result` line, so its
  probe runs one short turn; pi reports both through a maestro extension loaded with `--extension` beside
  `--no-extensions`. The window is kept per harness and model, and every agent turn refreshes it; Context shows it where
  known, and `--json` carries it as `window`.
- Every agent session records its harness's report: `ls <concert>` lists the faults of an agent's latest one, as the
  profile declares its environment, under an `Environment` heading, and `ls --json` carries the checks in the instance's
  report.

### Repertoire

`repertoire <pack>.<composition>` shows its doc, each param as the flag to type with its type and default or `required`,
the config entries its host nodes read by name when built from its example set (a `Config` line, `config` in `--json`),
and a `maestro perform` line with the required flags. A pack that fails to load is named on stderr, the rest are listed,
and the exit is 1.

### Pruning

`prune` deletes a settled concert's files and what its hosts hold. Without `--before` there is no age cutoff, and
`--status running` is refused.

## Config

Layers, lowest first: the defaults, `$XDG_CONFIG_HOME/maestro/config.yaml`, the nearest `.maestro/config.yaml`, the
preset each `--preset <name>` names, in order, then each `-c` in order. The full ladder is in
[architecture: Configuration](../../docs/architecture.md#8-configuration). Maps merge by key and a list is replaced by
the layer above it. A tag changes that: `!replace` on a map, `!append` on a list, `!delete` to drop a key.
`maestro config <composition>` shows where each value came from, naming a preset layer by its name (`preset high`), each
value with its layer, file and line or `-c`. A required param of the composition that no layer gives shows as an `unset`
row, and in `--json` as `layer: "unset"` with `value: null`; `config` runs no pre-flight, so it exits 0. Presets combine
without a merged file: `--preset high --preset stub` layers `stub` over `high`. A composition's params sit under the id
of the pack that declares it, whichever root uses it: `classics.panel.skeptics` reaches the panel of any root. A `-c`
key under a composition the concert does not use is refused (`CFG.unreached`); the same key in a file or preset is
ignored, its value still checked against the param's schema.

A preset is `<name>.yaml` in the workspace's `.maestro/presets/`, else in `$XDG_CONFIG_HOME/maestro/presets/`; the
workspace's file wins the name whole. A compose or perform error that a missing setting raised, such as a profile with
no harness or a check config lacks, gets the hint `Pass --preset <name>` when presets set it, each one named.

`-c <key>=<value>` sets one key, checked by the same schemas, and an error names the flag. The key is a dotted path,
with a key holding a `.` in double quotes; the value is YAML, so `=true` is a boolean, `=[a, b]` a list, and the tags
work:

```sh
maestro perform demo.greet --name x -c concurrency=2 -c 'packs=!append [../b]' -c target.checks.lint=!delete
maestro perform demo.greet --name x -c 'profiles.reviewer.runtime=!replace {harness: stub}' -c 'target.checks."a.b"=x'
```

A profile's fields resolve per field, highest first: `-c` and the presets, then the config files' `profiles`, then the
profile directory's `profile.yaml`. So `--preset stub` always means no spend, while
`-c profiles.builder.runtime.model=haiku` changes only the model. A composition sets none of them.

A layer's `profiles."*"` entry applies to every profile that layer does not name, at that layer's precedence, and its
named entries win over it field by field; the tags work on it as on a named entry, and `maestro config` lists it as
`profiles.*`. So `.maestro/presets/stub.yaml` stubs every seat, whatever profiles the config files or a pack bring; the
[host-repo README](../host-repo/README.md#stub-harness) holds the stub harness and its `MAESTRO_STUB_*` variables:

```yaml
profiles:
  "*": { runtime: !replace { harness: stub } }
```

A concert's record keeps each `--preset` and each `-c` as typed, in order. Keep secrets out of `-c`: set them in
`$XDG_CONFIG_HOME/maestro/.env`. maestro loads that `.env` when it exists, a variable the shell sets winning; the
release binary reads no `.env` or `bunfig.toml` from the cwd, while a run through `bun` from the repository still does.
The Claude Code harness reads its token from `CLAUDE_CODE_OAUTH_TOKEN`, set there or in the shell; get one with
`claude setup-token`.

The core keys are `packs`, `concurrency`, `dataRoot`, `workspace`, `caps` and `limits`, described in
[architecture: Core keys](../../docs/architecture.md#core-keys); the repo host's `target`, `profiles` and `sandbox` are
in the [host-repo README](../host-repo/README.md#configuration). A pack is operator-trusted code: `maestro` loads and
executes what `packs` lists, and every directory under `$XDG_DATA_HOME/maestro/packs/`, with the user's own permissions.

Past a `limits` value the concert is cancelled as `kill` cancels it, and settles `failed` naming the limit, such as
`passed limits.tokens (2000000): 2104331 tokens`. The token sum is checked as each node instance settles, so a long
agent is bounded mid-run by its profile's own `limits`. A resume reads them as the config stands, its recorded `-c`
beneath its own. `timeout` restarts at each attempt, while the token sum counts earlier attempts, so a resume already
past `tokens` fails at its next settled instance unless `-c` raises it.

A relative `packs`, `dataRoot`, `target.repo` or other path key is relative to the workspace root, the directory that
holds `.maestro/`, in the workspace file, a workspace preset and a `-c`, and to the user config directory in the user
file and a user preset. A `-c` outside a workspace is relative to the cwd.

## Data root

The layout is in [architecture: Data root](../../docs/architecture.md#data-root). The repo host keeps its lanes,
versions and sessions in `hosts/repo/<target id>/`, and each model's context window in `hosts/repo/windows.json`.
