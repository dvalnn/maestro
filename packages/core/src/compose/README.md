# compose

`compose(input)` is pre-flight (architecture 4, CORE-07). It does three things without spending anything:

- checks an IR against its config and hosts;
- expands the groups whose items are plain values;
- bounds the result.

It calls no author code, writes nothing and starts no host node (NFR-02, ADR 0009). It returns `{ ok: true, plan }`, or
`{ ok: false, diagnostics }` when any check gives an error.

## Input

| Field      | Holds                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `ir`       | IR that `parseIr` accepted.                                                                       |
| `config`   | The layered config: its values, and each value's source (`../config`).                            |
| `core`     | The config schemas the engine owns, by top-level key.                                             |
| `packs`    | Each installed pack's claims: its id, then its compositions' ids, then each one's param names.    |
| `hosts`    | The installed hosts.                                                                              |
| `loadCode` | Resolves a worker reference to its function (ADR 0008), once per reference per compose.           |
| `caps`     | Caps by name: `instances` caps the node-instance total, any other name the total of a host count. |

## Steps

1. Checks, in this order:
   - edge types, artifact markers and type owners;
   - config, each diagnostic at the file and line that set the key (D-24);
   - host nodes against their kinds: the kind, the `config` and the ports (architecture 6).

   Any error stops compose here, before anything is loaded or called.

2. Loading, through `loadCode`, of every function the IR names: each code node's worker and each map's key function,
   once per reference. One that does not load is a `SCOPE.export` error, which stops compose here (ADR 0008). No loaded
   function is called.
3. Expansion, enclosing groups first, one group instance at a time. A group instance expands only when every guard on it
   is known true and its items are plain values: a literal, or an enclosing group's item. Then:
   - a `map` expands into one instance per item, keyed by `itemKey`;
   - a `map` with a key function expands to a count of its items, as the key function is called only at perform;
   - a `seq` without `until` expands into one instance per index.

   Every other group instance stays a region of up to its bound (CORE-05), as do a `repeat`, a `seq` with `until`, a
   group sized by a node result, and a group whose guard a node result feeds.

   When the IR's own bounds, with every group at its declared bound, pass a cap, expansion checks the bounds so far
   after each group instance. A group instance not yet reached counts nothing, so the bounds so far only grow. Expansion
   stops at the first cap they pass, with a `BOUND.cap` error that says "may reach at least".

4. Each host's `validate(graph)`. Its codes get the `HOST.` prefix.
5. The plan's bounds, from the expansion, against `caps`.

A host's `validate()` that throws or rejects gives a `HOST.validate` error naming the host. Two hosts that register one
node kind still throw.

## Plan

The plan is JSON, and `Plan` in `index.ts` is its type. In V1 it is output only: perform takes the IR, not a plan, so
the plan carries no format version.

| Field         | Holds                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `ir`          | The IR, unchanged.                                                        |
| `expansion`   | Group id, then the group instance's expansion path, then its `Expansion`. |
| `bounds`      | `PlanBounds`, below.                                                      |
| `diagnostics` | Warnings only, each an ir `Diagnostic` (`packages/ir/src/types.ts`).      |

Expansion paths are ir's (`formatExpansion`): one `[key]` per enclosing group, outermost first, `""` outside groups. A
map item's key is its `itemKey`, or at perform its key function's. A `seq` or `repeat` iteration's key is its index.

An `Expansion` is either:

- `{ keys }`: the instance's iteration keys in order.
- `{ exact }`: a map's iteration count, when its key function names the iterations at perform.
- `{ upTo }`: a region with its bound.

`PlanBounds` (D-23):

| Field       | Holds                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| `instances` | The node-instance total, groups included, as a `Cardinality`: `{ exact }` or `{ upTo }`.  |
| `nodes`     | Instances per node id.                                                                    |
| `counts`    | Each name a host's `bounds(node)` reports, times the node's instances, summed over nodes. |

A count is exact only when every group above it is a map whose items compose knows.

A plan for a map over two topics, then a repeat, with a host that counts one `calls` per node and `ir` cut short:

```json
{
  "ir": { "irVersion": "1.0", "nodes": [], "edges": [] },
  "expansion": {
    "topics": { "": { "keys": ["alpha", "beta"] } },
    "loop": { "": { "upTo": 2 } }
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

| Code            | When                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| `CFG.unclaimed` | A config key nothing installed claims, at any level.[^claims] Hints a near name.           |
| `CFG.schema`    | A config namespace is off the schema of core or a host whose kinds the IR uses.[^pack]     |
| `CFG.claim`     | A pack's id is a namespace core or an installed host already claims.                       |
| `TYPE.edge`     | An edge's source and target schemas disagree.[^types]                                      |
| `TYPE.marker`   | An `x-maestro-type` the artifact walker cannot reach.                                      |
| `TYPE.owner`    | An `x-maestro-type` name neither core (`CORE_TYPES`) nor an installed host owns.           |
| `HOST.kind`     | A node kind no installed host registers.                                                   |
| `HOST.config`   | A host node's `config` is off its kind's `config` schema.                                  |
| `HOST.ports`    | A host node's `in` or `out` differs from its kind's `ports(node)`.[^ports]                 |
| `HOST.validate` | A host's `validate()` threw or rejected.                                                   |
| `HOST.*`        | A host's `validate` finding.                                                               |
| `SCOPE.export`  | `loadCode` could not load a function the IR names: a code node's or a key function.[^load] |
| `SCOPE.key`     | Two items of a map instance share a key.[^keys]                                            |
| `BOUND.items`   | A group instance has more known items than its bound.                                      |
| `BOUND.cap`     | A total of the plan's bounds, or of its bounds so far while expanding, is over its cap.    |

[^claims]:
    A top-level key belongs to core, an installed host or an installed pack. Under a pack's id, a key names one of its
    compositions, and under that, one of its params (D-17). A key only an unused host claims is ignored (D-24).

[^pack]: Or a pack's value, or a composition's under it, is not a mapping.

[^load]: The hint is the load error's message after its first line, when it has one.

[^types]:
    The `x-maestro-type` names, then the JSON `type` (an `integer` fits a `number`), then `items` and shared
    `properties`. Enums, `required`, extra properties and annotations are ignored, and only a `core.json-file` compares
    what a marked subschema says of its content. A `data` edge into a fan-in input is checked against the `Settled`
    value (ADR 0006).

[^ports]:
    By port name, then by the edge rule on each shared port: values flow from the IR's `in` into the kind's, and from
    the kind's `out` into the IR's. A `ports(node)` that throws is a `HOST.ports` error too. A node with a `HOST.config`
    error gets no ports check.

[^keys]:
    Keys come from `itemKey`, so `3` and `"3"` collide, as do an item keyed by its index and a primitive item with that
    value. The hint is to give the map a key function, whose duplicate keys fail the `map` at perform.

No value gets its schema defaults. `format` is an annotation only: neither compose nor perform validates it.

## Text forms

- `summary(plan)`: one line, for example `fanout: up to 16 node instances`.
- `listing(plan)`: each node with its kind and instance count and its expansions, then the bounds and any warnings.
- `render(plan)`: a Mermaid flowchart (architecture 11). Scopes and groups are subgraphs, and a group's header shows its
  kind, cardinality and expansions.

| Drawn as        | Means                                                     |
| --------------- | --------------------------------------------------------- |
| `[ ]`           | A code node.                                              |
| `[/ /]`         | A fan-in code node, the reducer behind a `collect`.       |
| `{ }`           | An assert.                                                |
| `([ ])`         | A host node.                                              |
| `[[ ]]`         | A group's header.                                         |
| `-->`           | A `data` edge, labelled `<from port> to <to port>`.       |
| `==>`           | A `collect` edge: the barrier before the fan-in.          |
| `-.->` `when p` | A guard on output `p`.                                    |
| `-.->` `after`  | An ordering edge, with `tolerates rejected` when it does. |

A key list is cut at 40 characters.
