# compose

`compose(input)` is pre-flight (architecture 4, CORE-07). It does three things without spending anything:
- checks an IR against its params, config and hosts;
- folds and expands what it can know;
- bounds the result.

It writes only under `input.scratch` and starts no host node (NFR-02). It returns `{ ok: true, plan }`, or
`{ ok: false, diagnostics }` when any check gives an error.

## Input

| Field      | Holds                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `ir`       | IR that `parseIr` accepted.                                                                        |
| `params`   | Param values, checked against `ir.params.schema` with its defaults applied (D-17).                 |
| `config`   | The composed config, by top-level namespace.                                                       |
| `core`     | The config schemas core owns, by namespace.                                                        |
| `hosts`    | The installed hosts.                                                                               |
| `loadCode` | Resolves a worker reference to its function (ADR 0008), once per reference per compose.            |
| `caps`     | Caps by name: `instances` caps the node-instance total, any other name the total of a host count.  |
| `scratch`  | An absolute directory, made with its parents the first time a folded node reads `ctx.scratch`.     |

## Steps

1. Checks, in this order:
   - params;
   - edge types;
   - config (D-24);
   - artifact markers and host kinds.

   Any error stops compose here, before anything is loaded or called.
2. Each host's `environment()`.
3. Folding and expansion, in dependency order, one node instance at a time. The rules:
   - A node after a non-`ok` folded upstream is `skipped` (CORE-04), unless a tolerant ordering edge admits a
     rejection or the node is a fan-in.
   - A guard that depends only on known values resolves:
     - `false` skips the node;
     - an unknown guard leaves the node, and a group's body, to perform.
   - A pure code node with known inputs and no artifact output is called with a pure context:
     - reading `ctx.concert` or `ctx.clock` throws;
     - calling `ctx.path()` throws, as a folded node has no artifact area;
     - `ctx.env` holds each host's `environment()` under the host's name.
   - An assert with known inputs folds; a false one is an error.
   - A group instance known to start expands, but only in these cases:
     - a `map` whose items are known expands into one instance per item;
     - a `seq` without `until` whose items are known expands into one instance per index.

     Every other group instance stays a region of up to its bound, as do a `repeat`, a `seq` with `until`, and a
     group whose guard is false or unknown. Of a region, only the first iteration (`[0]`) may fold: it always starts,
     and inside a `repeat` its state ports hold the repeat's own inputs.

   When the IR's own bounds, with every group at its declared bound, pass a cap, fold checks the bounds so far after
   each group instance. A group instance fold has not reached counts nothing yet, so the bounds so far only grow. Fold
   stops at the first cap they pass, with a `BOUND.cap` error that says "may reach at least".
4. Each host's `validate(graph)`. Its codes get the `HOST.` prefix.
5. The plan's bounds, from the expansion, against `caps`.

A host hook that throws or rejects gives a `HOST.environment` or `HOST.validate` error naming the host. What still
throws:
- two hosts that register one node kind;
- a failure to remove a folded node's scratch directory.

## Plan

The plan is JSON, and `Plan` in `index.ts` is its type. In V1 it is output only: perform takes the IR, not a plan, so
the plan carries no format version.

| Field         | Holds                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `ir`          | The IR, unchanged.                                                                              |
| `params`      | The param values, defaults applied.                                                             |
| `expansion`   | Group id, then the group instance's expansion path, then its `Expansion`.                       |
| `folded`      | Node id, then the instance's expansion path, then its `Settled<Outputs>`.                       |
| `bounds`      | `PlanBounds`, below.                                                                            |
| `diagnostics` | Warnings only, each an ir `Diagnostic` (`packages/ir/src/types.ts`).                            |

Expansion paths are ir's (`formatExpansion`): one `[key]` per enclosing group, outermost first, `""` outside groups. A
map item's key is its `itemKey` or its key function's. A `seq` or `repeat` iteration's key is its index.

An `Expansion` is either:

- `{ keys }`: the instance's iteration keys in order.
- `{ upTo }`: a region with its bound. Its body may still have a folded `[0]` instance.

A `folded` entry is `{ outcome: "ok", value }` with the node's outputs, `{ outcome: "rejected", reason }` or
`{ outcome: "skipped", reason }`. An `ok` assert's value is `{}`.

`PlanBounds` (D-23):

| Field       | Holds                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| `instances` | The node-instance total, groups included, as a `Cardinality`: `{ exact }` or `{ upTo }`.  |
| `nodes`     | Instances per node id.                                                                    |
| `counts`    | Each name a host's `bounds(node)` reports, times the node's instances, summed over nodes. |

Counts include instances that folded or were skipped. A count is exact only when every group above it is a map whose
items compose knows.

A plan for a map over two topics, then a repeat, with a host that counts one `calls` per node and `ir` cut short:

```json
{
  "ir": { "irVersion": "1.0", "nodes": [], "edges": [] },
  "params": { "topics": ["alpha", "beta"] },
  "expansion": {
    "topics": { "": { "keys": ["alpha", "beta"] } },
    "loop": { "": { "upTo": 2 } }
  },
  "folded": {
    "topics/slug": {
      "[alpha]": { "outcome": "ok", "value": { "text": "ALPHA" } },
      "[beta]": { "outcome": "ok", "value": { "text": "BETA" } }
    }
  },
  "bounds": {
    "instances": { "upTo": 8 },
    "nodes": {
      "topics": { "exact": 1 },
      "topics/slug": { "exact": 2 },
      "topics/draft": { "exact": 2 },
      "loop": { "exact": 1 },
      "loop/step": { "upTo": 2 }
    },
    "counts": { "calls": { "upTo": 4 } }
  },
  "diagnostics": []
}
```

## Diagnostics

| Code               | When                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `CFG.params`       | A param value is off the param schema.                                                   |
| `CFG.unclaimed`    | A config key no core, IR or installed host namespace claims. Hints a near name.          |
| `CFG.schema`       | A config namespace is off the schema of core, the IR or a host whose kinds the IR uses.  |
| `TYPE.edge`        | An edge's source and target schemas disagree.[^types]                                    |
| `TYPE.marker`      | An `x-maestro-type` the artifact walker cannot reach.                                    |
| `TYPE.output`      | A folded node's outputs are off its `out` schemas.                                       |
| `HOST.kind`        | A node kind no installed host registers.                                                 |
| `HOST.environment` | A host's `environment()` threw or rejected.                                              |
| `HOST.validate`    | A host's `validate()` threw or rejected.                                                 |
| `HOST.*`           | A host's `validate` finding.                                                             |
| `PURE.ambient`     | A folded node read `ctx.concert` or `ctx.clock`, or called `ctx.path()`.                 |
| `PURE.fold`        | A folded node or a key function threw.                                                   |
| `SCOPE.export`     | `loadCode` could not load a folded node's function or a key function.                    |
| `SCOPE.key`        | Two items of a map instance share a key.[^keys]                                          |
| `ASSERT.failed`    | A folded assert is false.                                                                |
| `BOUND.items`      | A group instance has more known items than its bound.                                    |
| `BOUND.cap`        | A total of the plan's bounds, or of its bounds so far while folding, is over its cap.    |

[^types]: The `x-maestro-type` names, then the JSON `type` (an `integer` fits a `number`), then `items` and shared
    `properties`. Enums, `required`, extra properties and annotations are ignored, and only a `core.json-file`
    compares what a marked subschema says of its content. A `data` edge into a fan-in input is checked against the
    `Settled` value (ADR 0006).
[^keys]: Keys come from `itemKey`, so `3` and `"3"` collide, as do an item keyed by its index and a primitive item
    with that value. The hint is to give the map a key function.

Only params get their schema defaults; other values are checked on a copy. `format` is an annotation only: neither
compose nor perform validates it.

## Text forms

- `summary(plan)`: one line, for example `fanout: up to 16 node instances, 0 folded`.
- `listing(plan)`: each node with its kind and instance count, its expansions and folded instances, then the bounds
  and any warnings.
- `render(plan)`: a Mermaid flowchart (architecture 11). Scopes and groups are subgraphs, and a group's header shows
  its kind, cardinality and expansions.

| Drawn as          | Means                                                     |
| ----------------- | --------------------------------------------------------- |
| `[ ]`             | A code node.                                              |
| `[/ /]`           | A fan-in code node, the reducer behind a `collect`.       |
| `{ }`             | An assert.                                                |
| `([ ])`           | A host node.                                              |
| `[[ ]]`           | A group's header.                                         |
| `-->`             | A `data` edge, labelled `<from port> to <to port>`.       |
| `==>`             | A `collect` edge: the barrier before the fan-in.          |
| `-.->` `when p`   | A guard, with its folded value when compose knows it.     |
| `-.->` `after`    | An ordering edge, with `tolerates rejected` when it does. |

Folded values show as `folded <instance> <outcome> <value or reason>` in the node's label. A value or reason is cut
at 40 characters and kept on one line.
