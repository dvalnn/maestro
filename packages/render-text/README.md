# @maestro/render-text

The text forms of a plan (architecture 11). It imports `@maestro/ir` alone: a `Plan` in, a string out.

- `summary(plan)`: one line, for example `fanout: up to 16 node instances`.
- `listing(plan)`: each node with its kind and instance count and its expansions, then the bounds and any warnings.
- `render(plan)`: a Mermaid flowchart. Scopes and groups are subgraphs, and a node inside one is named by its id's last
  segment. A code node shows its worker export only when it differs from that name. A group's header, inside the
  subgraph that names its id, shows its kind and its expansion (one line per path when there are several), or its
  cardinality when nothing expanded. A loop's region shows its steps: `0 to N` when it tests the state first, `1 to N`
  when it tests each step's result. `start` points at each node with no incoming edge outside a group body, and the
  result node points at `stop`, drawn `end`.

`@maestro/render-text/live` draws a concert as it goes, from the IR and the record's events:

- `seen(prior, events)`: each instance's state, the latest event winning.
- `frame(ir, seen, view)`: the outline of the IR with each instance's glyph, name, kind, state, time and note, under a
  header with the concert's status, elapsed time and counts. Lines are cut at `columns - 1` terminal cells, and past
  `rows - 1` lines it ends with `… <n> more`.
- `eventLine(ir, event, view)`: one event as its offset from the concert's start, instance name and what happened. A
  progress event shows its `kind`, then each other field; a multi-line string continues indented.

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
| `==>`                      | A `collect` edge: the barrier before the fan-in.                                   |
| `-.->` `when p, else skip` | A guard on output `p`: when false the node is skipped.                             |
| `@{ shape: fork }`         | A bar after a node with several outgoing edges.                                    |
| `@{ shape: join }`         | A bar before a node with several incoming edges.                                   |
| `-.->` `after`             | An ordering edge, with `tolerates rejected` when it does.                          |

Every edge counts toward the bars, guards and ordering edges included, except a group's reads of its own body and the
`next` loop-backs, which are drawn direct. Each bar is declared inside its node's subgraph. Bars need Mermaid 11.3 or
later. A key list is cut at 40 characters. The plans the tests draw are ir's `fixtures/plans`.
