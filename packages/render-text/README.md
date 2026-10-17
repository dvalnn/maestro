# @maestro/render-text

The text forms of a plan (architecture 11). It imports `@maestro/ir` alone: a `Plan` in, a string out.

- `summary(plan)`: one line, for example `fanout: up to 16 node instances`.
- `listing(plan)`: each node with its kind and instance count and its expansions, then the bounds and any warnings.
- `render(plan)`: a Mermaid flowchart. Scopes and groups are subgraphs, and a node inside one is named by its id's last
  segment. A code node shows its worker export only when it differs from that name. A group's header, inside the
  subgraph that names its id, shows its kind and its expansion (one line per path when there are several), or its
  cardinality when nothing expanded. `start` points at each node with no incoming edge outside a group body, and the
  result node points at `stop`, drawn `end`.

## Drawing rules

| Drawn as        | Means                                                                              |
| --------------- | ---------------------------------------------------------------------------------- |
| `[ ]`           | A code node.                                                                       |
| `[/ /]`         | A fan-in code node, the reducer behind a `collect`.                                |
| `{ }`           | An assert.                                                                         |
| `([ ])`         | A host node.                                                                       |
| `[[ ]]`         | A group's header.                                                                  |
| `-->`           | `data` edges between two nodes: `<from> to <to>` per port, a same-named port once. |
| `-.->` `next`   | A repeat's body result feeding its next iteration.                                 |
| `==>`           | A `collect` edge: the barrier before the fan-in.                                   |
| `-.->` `when p` | A guard on output `p`.                                                             |
| `-.->` `after`  | An ordering edge, with `tolerates rejected` when it does.                          |

A key list is cut at 40 characters. `fixtures/` holds the plans the tests draw.
