# @maestro/render-text

The text forms of a plan (architecture 11). It imports `@maestro/ir` alone: a `Plan` in, a string out.

- `summary(plan)`: one line, for example `fanout: up to 16 node instances`.
- `listing(plan)`: each node with its kind and instance count and its expansions, then the bounds and any warnings.
- `render(plan)`: a Mermaid flowchart. Scopes and groups are subgraphs, and a node inside one is named by its id's last
  segment, and every subgraph's title is its path relative to its container. A code node shows its worker export only
  when it differs from that name. A group's header, inside the subgraph that names its id, shows its kind and its
  expansion (one line per path when there are several), or its cardinality when nothing expanded. A loop's region shows
  its steps: `0 to N` when it tests the state first, `1 to N` when it tests each step's result. `start` points at each
  top-level node that waits on nothing outside it (a group waits on what feeds its body), and the result node points at
  `stop`, drawn `end`.

`@maestro/render-text/live` draws a concert as it goes, from the IR and the record's events:

- `seen(prior, events)`: each instance's state, the latest event winning.
- `frame(ir, seen, view, agents)`: a header with the concert's status, short id and elapsed time, then `now`, `last`,
  the rows and a footer of the node instances counted and the concert's tokens.
  - `now` names the latest started running instance as a reader would (`test-loop ⟲2 › repair`), with `+n running` when
    more are. `last` names the latest `failed` instance and its reason; a later `rejected` one never takes its place.
  - The rows draw the authored shape, each node once. A loop shows its latest round, with a strip of each round's state
    (`⟲ 2/3   1✗ 2●`). Under a `parMap` or `parFind` a node is one row for all its items, with a strip of theirs
    (`lens ×3 … correctness ✓  spec !`). A fan-out counts its items against its cardinality, `n/≤N` for an `upTo` one.
  - A container is open (`▾`) while it holds running work, and once the concert settled while it holds the last failure;
    else it folds to its row (`▸`). A scope's state is the worst outcome of its rows, each group by its own instance.
  - A stdlib helper shows only while running, rejected or failed. A node that never started is `pending`, and
    `not reached` once its round, group or concert is done.
  - Lines are cut at `columns - 1` terminal cells. Past `rows - 1` lines, settled rows hide from the top, then pending
    ones from the bottom, each stretch as one `… <counts>` line; the running rows, the last failure and the rows above
    them stay, and the footer points at `maestro ls <short id>`.
- `browse(ir, seen, view, agents, nav)`: the same graph to drive with keys, in `view.rows` lines: the header, `now` and
  `last`, a viewport of the rows, each behind a lead column holding `>` on the cursor's row, which color also puts in
  reverse video, a rule of counts with the rows in view, the cursor row's instance, kind, state, time and agent, then
  its note, and a key line that drops its last hints but `q quit` when narrow. Folds and loop rounds follow `nav`: a row
  opened or closed by hand stays so, the rows above the cursor open, and a pinned round is shown in place of the latest,
  marked `(history)`. Following, the cursor goes to the latest started running instance, its aggregated row under a
  fan-out, and once the concert settled to the last failure. The cursor keeps 2 rows from the viewport's edge while rows
  remain beyond it. It gives the lines, `nav` resolved against the rows, and what `press` reads.
- `arranged(ir, instances)`: instances in the order `ls` lists them: a subcomposition's members under its name, a loop's
  by round, each round's in node order.
- `agentText(actor, metrics)` and `agentsOf(records)`: the agent column, `<harness> · <model> · <effort>  <total> tok`,
  with the model minus its provider prefix and the effort when the role sets one; and each current instance's actor and
  total, which `frame` shows, a container row its instances' total.
- `tokensOf(metrics)` and `compact(n)`: the sum of the `tokens_*` metrics but `tokens_reasoning`, and a count as `999`,
  `15.5k` or `1.2M`.
- `shortId(id)` and `shortIds(ids)`: a concert's short id, the UUID's last 15 hex digits in jj's reverse-hex letters
  (`0` to `f` as `z` to `k`); and, worked out once for the concerts `ids`, how many of each one's leading letters no
  other shares (`unique(id)`) and its label (`label(id, color)`), at least 8 letters, the unique ones bold and the rest
  dim.
- `closingBlock(view, ending, outputsColor)`: how a settled concert ended, in one label column: a `concert` row with its
  short id, outcome, elapsed time and tokens, then `at` and a `reason` that wraps under the value column at
  `view.columns`, and a row per output, colored when `outputsColor`. A value not wrapped shows as it is. Without
  `ending`, the `concert` row alone.
- `flat(text)`: text on one line, control characters shown as escapes.
- `eventLine(ir, event, view)`: one event as its offset from the concert's start, instance name and what happened. A
  progress event shows its `kind`, then each other field; a multi-line string continues indented.

`@maestro/render-text/press` turns input into navigation, with no terminal:

- `keysOf(chunk)`: the keys in a chunk of raw input: vi keys, arrows, paging, Home and End as terminals send them,
  space, `[`, `]`, `e`, `f`, Enter as `enter`, a lone Esc as `esc`, `q` as `quit` and Ctrl-C as `interrupt`. Unbound
  input is left out.
- `isInput(text)`: whether `text` names an input, such as `down` or `enter`.
- `ends(input, nav)`: whether an input ends the view: `interrupt` always, `quit` on the tree.
- `press(input, browsed)`: the navigation after an input on a browsed view, from the navigation it was drawn with;
  browse first from `NAV`.
  - On the tree, a move turns follow off; `f` turned on drops the pinned rounds and keeps the folds; `[` and `]` step
    the round of the loop the cursor is in, and stay put at either end; `e` goes to the last failure, its path opened
    and its rounds pinned; `enter` opens the inspector on the cursor row, tailing.
  - In the inspector, `up`, `down` and paging scroll its events, `first` goes to the top and `last` to the newest; a
    scroll that reaches the newest line tails again, any other stops tailing. `left`, `enter`, `esc` and `quit` go back
    to the tree.

`@maestro/render-text/inspect` shows a row's part of the record, with no terminal:

- `selected(graph, key, events)`: the events of the instances the row keyed `key` stands for, in their order: an item
  row's one instance, any other row's instances at or under its node in its context.
- `inspectorLines(ir, seen, view, key, held)`: the title and summary, then the event lines. One instance of the row's
  own node shows its context, state, times, tokens, actor, a `stale` mark, its reason or latest progress, then from the
  record its metrics by name, outputs as JSON, artifacts with their content hash and raw enrichment on one line, each
  left out when absent. More instances, or none, show their count by state, tokens and span. Each event is drawn as
  `eventLine` draws it, cut at `columns - 1` cells. `held.events` is only appended to, and only the events new since the
  last call are drawn.
- `navigated(ir, seen, view, agents, nav, held)`: `browse`'s tree, or with `nav.inspect` the inspector: the header,
  `now` and `last`, the summary, a viewport of event lines that keeps the newest in view while tailing, a rule counting
  the events and the lines in view, and the key line.

Color, when `view.color` is set, goes on after the cut; a glyph and a state word name each state, so the text reads the
same without it. A control character in shown text appears as its escape.

## Drawing rules

| Drawn as                   | Means                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `[ ]`                      | A code node.                                                                       |
| `[/ /]`                    | A fan-in code node, the reducer behind a `collect`.                                |
| `{ }`                      | An assert.                                                                         |
| `([ ])`                    | A host node.                                                                       |
| `[[ ]]`                    | A group's header.                                                                  |
| `-->`                      | `data` edges between two nodes: `<from> to <to>` per port, a same-named port once. |
| `-.->` `next`              | A loop's body result feeding its next iteration.                                   |
| `-.->` `test`              | The body node a loop's `test`, or a `find`'s or `parFind`'s `cond`, reads.         |
| `-.->`                     | A group member to its header, which delivers its outputs.                          |
| `==>`                      | A `collect` edge: the barrier before the fan-in.                                   |
| `-.->` `when p, else skip` | A guard on output `p`: when false the node is skipped.                             |
| `@{ shape: fork }`         | A bar after a node with several outgoing edges.                                    |
| `@{ shape: join }`         | A bar before a node with several incoming edges.                                   |
| `-.->` `after`             | An ordering edge, with `tolerates rejected` when it does.                          |

Every edge counts toward the bars, guards and ordering edges included, except a group's reads of its own body and the
dashed `next`, `test` and member edges, which are drawn direct. Each bar is declared inside its node's subgraph. Bars
need Mermaid 11.3 or later. A key list is cut at 40 characters. The plans the tests draw are ir's `fixtures/plans`.
