# Running: compose, perform, follow, read, recover

Reference for the verbs after bootstrap, grouped by verb, with what their output means. Every flag not named here is in
`maestro <verb> --help`. Each verb but `cs` takes `--json` (one JSON document on stdout), and each takes
`--profile <name>`, `-c <key>=<value>` (repeatable) and `--debug`.

Output is colored only on a terminal stream. `--no-color`, `NO_COLOR` or `TERM=dumb` turns it off, so a command you read
is plain either way.

## Compose

`maestro compose <c> [param flags]` builds the composition and pre-flights it. It spends nothing and writes nothing
unless given `--out`.

- `<c>` is `<pack>.<composition>`, a `.ts` or `.js` composition file, or a `.json` IR file.
- Params are flags in kebab-case: `maxRepairs` is `--max-repairs <value>`; a boolean is `--strict` or `--no-strict`. A
  param with no flag takes its value from config (a pack's only), then its default.
- Compose falls back on the composition's first example set for params no flag or config gives, an optional param only
  when no optional param is given, so a composition composes with no flags and a config-driven compose shows what
  perform will run. Perform never uses the example set.
- Default output: one line, `<name>: <count> node instances, <count> repo.agent`, with `up to` where a group or loop
  bounds it. Warnings and diagnostics go to stderr.
- `--plan` prints every node with its kind and count, an `agents:` block with each agent's resolved harness, model and
  thinking and the layer that set each (`default`, `user`, `workspace`, `profile`, `flag`, or `composition` for an
  inline role field), and the bounds. `--json` adds the same as `agents` beside `plan`. `--graph` prints a Mermaid
  flowchart.
- `--out plan.json` saves the IR, with a bare file's code beside it as `plan.bundle.js`. `maestro perform plan.json`
  performs exactly that IR, taking no param flags.

A diagnostic prints as `<code>: <message>` then its hint, indented. The hint is the fix.

## Perform

`maestro perform <c> [param flags] [--tour <slug>] [--title <text>]` pre-flights, then performs the plan as a concert.

- It runs in the foreground until the concert settles. SIGINT or SIGTERM cancels the concert, which settles `failed`.
- Start it detached, as SKILL.md's loop step 4 shows, and read the id from its stderr file.
- Stderr: `concert <id>`, the full id, once the concert starts, then, when it settles, the closing block: a
  `concert <short id>  <outcome>  <elapsed>[ · <tokens> tokens]` row, then `at <instance>` and `reason <reason>` lines
  when not `ok`. Pre-flight diagnostics come before the first line.
- Stdout: one `<port>  <value>` line per output of the result, its labels in the closing block's column. A string,
  number, boolean or `null` prints as is, any other value as compact JSON, and an artifact as its absolute path. A
  `rejected` concert shows its root cause's outputs, such as a check's `logs` and `lane`; a `failed` one shows none.
- `--json`: stdout holds `{ id, status, resultNode, resultExpansion, reason, outputs }`; an artifact there is
  `{ path, contentHash, producer }`, its `path` relative to the concert's artifact directory (see Records). The id still
  comes first on stderr.
- `--tour <slug>` puts the concert on a tour (dot-separated segments of lower-case words joined by hyphens, such as
  `epic.story`, at most 64 characters), else `MAESTRO_TOUR` does. `--title <text>` labels it in `ls`.

## Follow

Each `<id>` below is a concert's full id, its short id (8 letters from `k` to `z`, as `ls` shows it) or a prefix of
either that no other concert's starts with. `--json` documents, paths and lane refs hold the full id; `ls --json` adds
each concert's short id as `short`.

- `maestro wait <id> --timeout <duration>` waits for the concert to settle, then prints what `perform` prints and exits
  with its code. A duration is a whole number and one unit: `500ms`, `90s`, `15m`, `12h`, `7d`. On the timeout it exits
  124 with the concert still running; wait again. Without `--timeout` it waits as long as the concert takes.
- `maestro ls` lists concerts, newest first: short id, title, tour, workspace, composition, status, disk use.
  `ls --help` lists its filters, such as `--status running` and `--tour <slug>`.
- `maestro watch <id>` shows the concert from its first event until it settles, and exits as `wait` does. On a terminal
  it redraws the graph in place and stays open after the concert settles until `q`, for a user to follow; Ctrl-C stops
  watching, not the concert. An agent conductor pipes it, which ends at settle, or uses `maestro wait`. With `--json`,
  or without a terminal and without `--events`, it prints a JSON Lines stream, a line per instance state change (per
  event with `--events --json`), ending with the concert document, a `{"type":"concert",...}` line holding
  `wait --json`'s. `--events` without `--json` prints an aligned text line per event instead. `--events --instance <id>`
  keeps only one instance's events, `<id>` as `ls <concert>` prints it; a group or scope id takes everything under it.
  It takes no timeout: bound it below your tool call's limit with `timeout 90s maestro watch <id>`, which exits 124.

## Records

`maestro ls <id>` lists the concert's node instances: instance, status, `stale`, reason.

- Rows come in graph order, every instance: scopes, groups and loop rounds nest, and one node's expansions keep the
  order they started in. `--json` lists `instances` in the same order.
- Instance names show their place in groups: `loop[0]/repair` is the first repair of a loop, `parMap[risk]/skeptic` the
  skeptic of item `risk`.
- `stale` marks a row an earlier attempt of a resumed concert left, which the resume neither reused nor replaced.
- The reason of the instance the closing block's `at` names is the concert's root cause.

`maestro art <id>` lists the concert's artifacts: instance, port, absolute path (`--json` adds `contentHash`), with a
`stale` column for instances an earlier attempt left; printing one's files adds a `warning:` line on stderr.
`maestro art <id> <instance>` prints the bytes of each file of an instance's artifacts as they are, after a `══ <file>`
line when there are several, and `maestro art <id> <instance> <file>` prints one, so it pipes. A file is its artifact's
basename plus any inner path: read an agent's prompt with `maestro art <id> <instance> staged/prompt.md`. `--path`
prints absolute paths instead. An instance with no artifacts yet exits 1.

`art` takes an instance as `ls <id>` prints it, or a unique ending of whole segments of one, such as `repair` for
`loop[0]/repair`. `watch --instance` takes the same ending of a node or scope id, such as `repair` for `loop/repair`. An
ambiguous ending is a usage error listing the matches.

`maestro ls <id> --json` gives the concert's row (`id`, `short`, `pack`, `composition`, `status`, `pid`, `startedAt`,
`settledAt`, `workspace`, `tour`, `title`) and `instances`, each with `node`, `expansion`, `status`, `reason`,
`outputs`, `metrics` (such as `tokens_in`), `artifacts` and `stale`.

The data root, `$XDG_DATA_HOME/maestro` (default `~/.local/share/maestro`) unless config's `dataRoot` moves it, holds:

| Path                             | Holds                                                      |
| -------------------------------- | ---------------------------------------------------------- |
| `record.db`                      | The record of concerts, node instances and events (SQLite) |
| `concerts/<id>/artifacts/<path>` | Each artifact, at the `path` its JSON shows                |
| `hosts/repo/<target id>/`        | The repo host's lanes, versions and sessions, per target   |

What each node leaves, as outputs of its instance:

- An agent: `report`, its final report text; `staged`, a directory holding the exact prompt it was given (`prompt.md`),
  its identity (`identity.md`) when it has one and each correction turn's message (`correction-1.md` on); `lane`, its
  version; and each declared output file.
- A check: `logs`, each line it ran and its output; `lane`, unless it only read one.
- A changeset node: `changeset`, a directory (next section).

## Changesets

A changeset is a directory holding `base`, the commit the lane was cut from, and `0001.patch`, `0002.patch` and on, one
commit each, its subject the lane version that wrote it. An empty changeset holds `base` alone.

`maestro cs show <id>` prints the concert's changeset as a diff on its base without touching the checkout, `--stat` or
`--summary` (tour, title, files changed) for less. Hand that to the user. Applying it is the user's step, taken on their
yes:

- `maestro cs apply <id>` stages it on the checkout's `HEAD`, the checkout being `target.repo` as the concert was
  performed with, or `-C <repo>` (relative to the current directory). It refuses an empty changeset, uncommitted tracked
  changes, and a checkout without the base (fetch it). Exit 3: a patch left conflicts, its markers in the files.
- `maestro cs drop --yes` resets the checkout's tracked files, undoing an apply. It takes no concert: pass `-C <repo>`
  when the checkout is not the config's `target.repo`.
- The changeset is the `result` node's changeset, else the last `ok` instance's changeset; `--node <instance>` picks
  another. On a concert that is not `ok`, stderr warns that it is that instance's changeset, not a delivered result.

## Lane refs

A lane version left by a concert is written `<concert id>.<node instance>`, such as
`01a15170-e9ec-7089-81d3-c7af21271198.test`; a `perform` prints one as a `lane` output. A composition takes one as a
param of type `Lane` and can fork it, read it, or make it into a changeset in a later concert. It cannot continue
(extend) it. `ls <id> --json` gives each instance's lane ref in its `lane` output. Lanes stay on disk until their
concert is pruned.

To look at a lane's files, its working tree is at `hosts/repo/<target id>/lanes/<concert id>/<instance>/work` under the
data root, under the last instance that extended it, the name URL-encoded (`loop[0]/repair` is `loop%5B0%5D%2Frepair`).
The versions before it are sealed in the host's own git store.

## Recover

What SKILL.md's Recover section leaves out:

- **Resume**: it reapplies the `--profile` and `-c` the concert was performed with, over the config files as they are
  now; a `--profile` or `-c` given to the resume goes on top. It finds the record store by today's `dataRoot`, so a
  concert performed with `-c dataRoot=<dir>` resumes only with that `-c` given again. An error naming the concert's
  recorded flag is fixed with a `-c` on the resume (`-c <key>=!delete` drops a recorded key), or by performing anew. It
  takes no composition, `--tour` or `--title`: the concert keeps its own. It is refused for a concert still running
  (wait or kill it first) and for one that settled `ok` (perform the composition as a new concert). The code it needs is
  the pack or file it was performed from, still at the same path. A resume runs the graph recorded at first perform, so
  an edit adds or removes no node; its code nodes load from the file as it is now, and their hash covers the whole
  bundle (ADR 0008), so any edit to the composition file reruns every code node, and dependents rerun when their inputs
  changed. A changed code hash prints a `warning:` line on stderr and the resume goes on. After editing a composition,
  perform a new concert.
- **Kill** waits up to 10 s for the concert to settle `failed` ("the concert was cancelled"). A concert whose process
  died without settling is marked `failed` ("process exited") when the record is next read.
- **Prune** selects by id, or by the filters in `prune --help`. The lane refs into a pruned concert go with it. It asks
  before deleting; without a terminal it needs `--yes`. It refuses a running concert named by id and leaves running ones
  out of a filter, and refuses `--status running`.

## Tours

`maestro tour <slug> <id>...` puts concerts on a tour; `maestro tour --clear <id>...` takes them off. Give the concerts
of one task a tour at perform time, so `ls --tour <slug>` finds them (and the tours under it, `epic` matching
`epic.story`) and `prune --tour <slug> --yes` clears them.
