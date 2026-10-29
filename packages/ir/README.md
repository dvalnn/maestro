# @maestro/ir

The IR is the language-neutral, versioned JSON form of a graph (D-09, IR-01). It is the contract between emitters (the
TypeScript SDK, or any other language) and the engine. ir also holds the data formats maestro emits (the plan and the
events) and what the SDK, core and renderers must all see, since the SDK imports nothing else (ADR 0007) and renderers
import ir alone. It depends on nothing beyond Ajv. This package holds:

- `ir.schema.json`: the published JSON Schema (draft 2020-12). It is the contract, and it is usable with any validator.
- `src/`: `parseIr`, `IR_VERSION`, `irSchema` and the TypeScript types, plus the shared contracts below: diagnostics
  (`Diagnostic`, `Severity`), outcomes (`OUTCOMES`, `Outcome`, `Settled`, `worstOutcome`, `settledSchema`), the
  code-function contract (`Context`, `CodeContext`, `Facts`, `Rejection`, `reject`, `TS_RUNTIME`), type markers
  (`MAESTRO_TYPE`, `CORE_TYPES`, `ARTIFACT_TYPES`, `registerMaestroType`, `findMarked`, `schemaMarkers`,
  `unreachableMarkers`, `artifactsAsRefs`), artifact references (`ArtifactRef`, `artifactRefSchema`), the graph index
  (`indexGraph`, `GraphIndex`, `IMPLICIT_OUT`, `outputValue`, `isGroup`, `boundOf`, `tolerates`, `LOOP_STATE`,
  `startNodes`), expansion paths (`itemKey`, `firstDuplicate`, `formatExpansion`, `parseExpansion`, `formatInstance`),
  the plan (`Plan`, `Expansion`, `PlanBounds`), events (`ConcertEvent`, `EventBody`, `NodeInstance`, `HostEvent`,
  `Enrichment`), schema validation (`validator`, `Validator`, `violations`), `messageOf` and `MAX_TIMEOUT`.
- `fixtures/`: golden hand-written IR files. Each one is accepted by `parseIr`, and its worker modules sit beside it. A
  `plans/<name>.json` is the plan compose gives the IR of that name, which the renderers' tests read.
- `test/read_ir.py`: an independent reader (Python standard library only), which proves the format is readable without
  maestro code.

```ts
import { parseIr } from "@maestro/ir";

const result = parseIr(JSON.parse(text));
if (!result.ok) console.error(result.diagnostics); // [{ code, severity, message, hint, path }]
```

`parseIr` checks the version first, then the schema, then the structural rules below. It never throws on bad input.

`Diagnostic` is the one diagnostic type of ir, the SDK and core (CORE-17): `code`, `severity`, `message` and `hint` (the
next step), plus optional `node`, `scope`, `source` and `path` (a JSON Pointer). Without those four it is about the
whole IR. Every diagnostic `parseIr` returns is an `error` with a hint and a path, and one whose path points into a node
with a string `id` also names that node in `node`.

## Version and compatibility (CORE-16, ADR 0004)

`irVersion` is `"<major>.<minor>"`. This package reads `1.0` and `1.1`, and emits `1.1`.

- **Minor** changes are additive and optional: a new optional field, or a new value where readers already reject the
  unknown. IR written for `1.n` keeps its meaning under every later `1.m`. A breaking change to the node config of a
  host that ships with maestro also bumps the minor, and that host refuses a node of the older shape by name.
- **Major** changes are anything else: a removed or renamed field, a new required field, a changed meaning, a new node
  or edge kind.
- A reader that supports `M.n` accepts `M.0` to `M.n`, and nothing else. It rejects another major, and a newer minor,
  with an `IR.version` diagnostic and a hint. Both checks come before the schema check, so IR of another major gets one
  clear error.
- So a 1.1 IR cannot be read by a 1.0 maestro. This is deliberate: an engine that silently ignored a field it does not
  know would perform the graph with the wrong meaning. The typical case is a pack that bundles a newer SDK than the
  `maestro` binary (D-30). The error says so and tells the operator to upgrade maestro.
- The schema's `irVersion` enum lists exactly the versions this package reads. It is bumped together with `IR_VERSION`,
  and a test checks that they agree.
- Any change to the IR updates the schema, the fixtures, `IR_VERSION` and the changelog at the end of this file (port
  plan rule 8).

## Document

| Field         | Content                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `irVersion`   | See above.                                                                                          |
| `composition` | `id`, `version`, `pack`, optional `doc`.                                                            |
| `emitter`     | `name` and `version` of what produced the IR, optional `sourceHash`. Hand-written IR uses `"hand"`. |
| `scopes`      | One per subcomposition use: `id`, `composition` and its `ports` with schemas.                       |
| `nodes`       | Flat list. Nesting is by id.                                                                        |
| `edges`       | Flat list, port to port.                                                                            |
| `result`      | `{ "node": id }`, the node the build returned, where the result rule starts (architecture 7).       |

Nodes and scopes share one id space. An id is a path of `[A-Za-z0-9_-]` segments joined by `/` (IR-01). Anything inside
a scope or a group has the id `<enclosing id>/<segment>`, so every proper prefix of an id is a declared scope or group
node, its parent is the id minus the last segment, and that last segment is its name. Scopes are for renderers and
diagnostics and do not change execution. Groups do.

Every schema inside the IR is a JSON Schema document that the IR treats as opaque, except for the `x-maestro-type`
annotation that names artifacts and host types ([Type markers](#type-markers-x-maestro-type)). Edge type checks are
pre-flight's job (CORE-02), not this package's.

## Nodes

Common fields: `id`, `kind`, `source` (`file`, `line`, `column`), `in` and `out` (port name to schema), and `literals`
(port name to a plain value, D-16).

A worker's `module` is relative to the IR file's directory. `codeHash` takes one of two forms (ADR 0008), and the schema
pairs each with its module both ways:

- `sha256:` plus 64 lowercase hex digits, the hash of the module file's bytes. The same form as an artifact's
  `contentHash`.
- `maestro:stdlib@<semver>` (`major.minor.patch`, optional pre-release and build parts), only on the reserved module
  `maestro:stdlib`, and that module takes no other form. The version is the building SDK's and informational.

The golden fixtures keep their modules beside them in `fixtures/`, and a test checks each hash.

Every node also has two implicit outputs, its status ports `ok` and `reason`, whose schemas are `IMPLICIT_OUT`. They,
and `outcome`, may not be declared in `out`. `outputValue(settled, outputs, port)` reads any port of a settled node,
implicit or declared.

| Kind                                               | Own fields                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `code`                                             | `worker` `{runtime, module, export, codeHash}`, optional `fanin` (a reducer, D-08),[^fanin] `timeout`.[^timeout] |
| `assert`                                           | `message`, `onFail` (`rejected` or `failed`). The condition is an input port.                                    |
| `parMap`, `map`, `find`, `parFind`, `fold`, `loop` | Groups, below.                                                                                                   |
| `<host>.<kind>`                                    | Any kind with a dot is a host kind, with an optional opaque `config` object.                                     |

### Groups

A group's body is the nodes whose nearest enclosing group is the group. The body is a template that is instantiated per
item or iteration. Every group has:

- `members`: result name to body node id. A member's value is its one entry's outputs, or a record of each entry's
  outputs by result name when it has several. A `parMap` and a `map` may have several. A `find`, a `parFind` and a
  `loop` take exactly one in 1.0, because their ports mirror that member's outputs, and a `fold` exactly `first` and
  `step`. Allowing more later is a minor change.
- `cardinality`: `{ "exact": n }` or `{ "upTo": n }` (CORE-05),
- `inner`: ports the body reads, in addition to `in` and `out`.

| Kind      | `in`                                 | `inner`                                           | `out`                | Own fields                   |
| --------- | ------------------------------------ | ------------------------------------------------- | -------------------- | ---------------------------- |
| `parMap`  | `items`[^items]                      | `item`                                            | `results`            | `items`, `key`, `onError`    |
| `map`     | `items`[^items]                      | `item`                                            | `results`            | `items`, `onError`           |
| `find`    | `items`[^items]                      | `item`                                            | the member's outputs | `items`, `cond`              |
| `parFind` | `items`[^items]                      | `item`                                            | the member's outputs | `items`, `key`, `cond`       |
| `fold`    | `items`[^items]                      | `item`, member's outputs, `ok`, `reason`, `index` | the member's outputs | `items`, `first`, `tolerate` |
| `loop`    | the member's outputs (initial state) | member's outputs, `ok`, `reason`, `index`         | the member's outputs | `test`, `tolerate`           |

- `items` is either a literal array on the node or an `items` input port fed by an edge, never both.
- A `parMap` over literal items, and any group over an empty literal list, is `exact` with the item count. Every other
  group is `upTo`, equal to the item count for literal items.
- `key` is an optional worker reference for an author key function (D-18) of a `parMap` or `parFind`.
- `onError` is `stop` or `continue`, and has no default (ADR 0006). With `stop` a `parMap` cancels its running members
  and a `map` starts no further item at a member that is not `ok`.
- `cond` is a body port `{node, port}` holding a boolean, read on each member. A `find` runs its members in order and
  stops once it holds. A `parFind` runs them all at once, ends on the first to settle with it holding and cancels the
  others. Either ends on its last member, or a `parFind` its last to settle, when it never holds. A member or `cond`
  node that settles `failed` fails the group.
- A `fold`'s `first` lists the body nodes that run on item 0, with inner `item` and `index` 0, its `first` member among
  them. The other body nodes run on each next item, with inner ports holding the previous accumulator's outputs, `ok`
  and `reason`, and the item and its index. `first`'s nodes read no accumulator port, no other body node reads them, and
  both members have the same outputs. A body node's id may put `first` or `step` after the fold's id, a phase segment
  that needs no declared scope. The fold ends on its last accumulator, or on one that is not `ok` unless
  `tolerate: "rejected"` carries it. A `fold`, `find` or `parFind` over no items settles `skipped`.
- `test` is `{ at, port }`, `port` holding a boolean. A `loop` goes on while it reads `true`, and fails when its node
  failed:
  - at `start` it is read before each step, and is a state port of the loop or a body port. A body port's node and the
    body nodes that node reads run first. They may not read the member, so a test at `start` reads only the loop state.
    The loop runs 0 to its bound steps.
  - at `end` it is a body port, read after each step. The loop runs 1 to its bound steps.
- `tolerate: "rejected"` on a `loop` or `fold` lets rejected state, including the initial state, carry into the next
  iteration.
- A `loop`'s inner state ports hold the previous iteration's member outputs, `ok` and `reason` (absent when `ok`), or
  for the first iteration its inputs, `ok` unless a node feeding it rejected, the first such to settle giving its
  `reason`. Whatever stops it, its test or its bound, the loop ends with its last state's outcome, reason and outputs.
- A member result with several entries takes the worst entry outcome (ADR 0006).

## Edges

Every input port is fed exactly once, by a `data` or `collect` edge or by a literal.

| Kind      | From                                 | To             | Meaning                                                                              |
| --------- | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------ |
| `data`    | `{node, port}`                       | `{node, port}` | A value or artifact flows.                                                           |
| `collect` | a `parMap` or `map`'s `results` port | `{node, port}` | The settled member results flow, as the explicit fan-in (CORE-03, D-08).             |
| `control` | `{node, port}`                       | `{node}`       | A guard. The target proceeds only when the boolean port is true, else it is skipped. |
| `control` | `{node}`                             | `{node}`       | Ordering. It may carry `tolerate: "rejected"` to admit a rejected upstream.          |

A dependent starts only after every upstream it has an edge from is `ok`, unless its edges from that upstream tolerate
`rejected` (CORE-04). `tolerates(node, edges)` is this rule for every edge from one upstream into `node`. They tolerate
it when:

- one is a control edge whose own `tolerate` says so, or any other edge into a `loop` whose `tolerate` says so;
- or each reads a status port, `ok` or `reason`.

An output a node declares but did not produce, as when it rejected without outputs, is never a crash. A data edge from
it skips its reader, with that node as the cause. A guard, a `cond` or a loop `test` that reads it reads not true.

The edge source decides which ports a group exposes. Seen from inside its body, a group exposes `inner`. From anywhere
else, it exposes `out` and the implicit outputs.

## Structural rules

Enforced by `parseIr` after the schema:

1. Ids are unique across nodes and scopes (`SCOPE.duplicate`).
2. Every proper prefix of an id is a declared scope or group node, or a fold's id and phase segment.
3. Every edge endpoint, port, literal, member, `cond`, `test` and result node resolves (`IR.ref`).
4. An edge never leaves a group body: only the group's `out` ports reach outside it.
5. Every input port is fed exactly once.
6. `collect` edges start only at a `parMap` or `map`'s `results` port, and that port feeds nothing else.
7. Group ports, `members`, `first`, `cond`, `test`, `items` and `cardinality` follow the group rules above.
8. The result node is not inside a group body.
9. Edges form no cycle. An edge into a body counts as an edge into its group.

Violations of rule 2 and rules 4 to 9 are `IR.graph`. Shape violations are `IR.schema`, and version problems are
`IR.version`.

## Graph index

`indexGraph(ir)` returns the lookups the structural rules use, for every consumer of the graph: a node or scope by id,
an entry's `parent` and `ancestors` (nearest first), both read from the id alone, the enclosing groups of a node
(`groupsOf`, outermost first, scopes left out), a group's `body` (the nodes whose nearest enclosing group it is) and the
edges into and out of a node. Otherwise an id that resolves to nothing gives `undefined` or an empty list.
`isGroup(node)` tells a group node, and `boundOf(cardinality)` is a group's most iterations.

## Expansion paths

A node instance is a node id plus its expansion path (architecture 7): one `[key]` per enclosing group, outermost first,
and empty outside groups. A `parMap` or `parFind` contributes its item's key, any other group its iteration index, so
the path of a node in a `loop` inside a `parMap` reads `[risk][2]`.

- `itemKey(item, index)` is a `parMap` or `parFind` item's key (D-18): a string, number, boolean or `null` item is keyed
  by its value, any other item by its index. Each character outside `[A-Za-z0-9_.-]` becomes `_`. Keys that come out
  equal are duplicates, so `3` and `"3"` collide; the caller reports them. `firstDuplicate(keys)` finds the first
  repeat.
- `formatExpansion(keys)` builds the path and throws on a key outside that alphabet. `parseExpansion(path)` returns the
  keys, or `undefined` for anything else. A key may be empty (`[]`), as `itemKey("")` is.
- `formatInstance(instance, groups)` merges an instance into one name, each key right after its group's id within the
  node id, given the node's enclosing groups: `lens/skeptic` in the parMap `lens` shows as `lens[risk]/skeptic`.

## Outcomes

A node settles `ok`, `rejected`, `failed` or `skipped` (`Outcome`, CORE-04). A settled value is `Settled<T>`:

```ts
type Settled<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "rejected" | "failed"; value?: T; reason: string }
  | { outcome: "skipped"; value?: T; reason?: string };
```

`worstOutcome(outcomes)` is the one rule wherever several outcomes collapse into one: `failed` > `rejected` >
`skipped` > `ok`, and an empty input is `ok` (ADR 0006). It decides a member with several results and a `parMap` or
`map` with `onError: "stop"`. `firstOk` with no `ok` input first counts `skipped` inputs as `rejected`, then takes the
worst.

`settledSchema(T)` is the JSON Schema of `Settled<T>`, closed to `outcome`, `value` and `reason`:

- `ok` requires `value` and has no `reason`.
- `rejected` and `failed` require `reason`, and `value` is optional.
- `skipped` has both optional.

T sits at `properties.value`. Port schemas describe the delivered value, so:

- a `parMap` or `map`'s `results` port, and every input fed by a `collect` edge, declare an array whose `items` is
  `settledSchema(T)`,
- a fan-in node's input fed by a `data` edge declares `settledSchema(T)`.

The golden fixtures do so with T `{ "type": "object" }`, a member's value, and a test keeps them equal to
`settledSchema`'s output.

**Fan-in edge rule.** A `data` edge into a fan-in input checks the upstream port's schema against the input's
`properties.value` subschema, not against the whole `Settled` schema (ADR 0006).

## Code functions

`src/code-function.ts` is the code-function contract, kept in one module so it can leave ir in one step:

- `Context`: what core gives every node instance, `concert` (the concert id), `clock`, `path(ref)` and `scratch`, the
  instance's own scratch directory (ADR 0007).
- `CodeContext`: `Context` plus `env`, each host's `Facts` keyed by host name, `signal`, an `AbortSignal` aborted when
  the instance is cancelled or times out, and `log(line)`, which records `line` as a `log` event on the instance.
- `TS_RUNTIME`: `"ts"`, the runtime name of the in-process TypeScript worker (CORE-14).
- `Rejection`: a code function's negative verdict, `{ outcome: "rejected", reason, outputs? }`, which
  `reject(reason, outputs?)` builds (ADR 0008). `outputs`, when given, are the node's full outputs, checked against its
  `out` like an `ok` node's. No node declares an `outcome` or `reason` port, so a rejection never reads as outputs.

## Type markers (`x-maestro-type`)

The annotation names an artifact or host type on any subschema of a schema in the IR (ADR 0007):

```json
{ "type": "array", "items": { "x-maestro-type": "core.file" } }
```

- **Namespaces.** A name is `<namespace>.<type>`, the pattern host node kinds use (`$defs/qualifiedName` in
  `ir.schema.json`). Core owns `core.file`, `core.dir`, `core.json-file` and `core.markdown` (`CORE_TYPES`). Each host
  owns the names it lists in its `types`. Compose rejects a name that neither core nor an installed host owns.
- **Registration.** Ajv's strict mode rejects unknown keywords, so whatever compiles port schemas calls
  `registerMaestroType(ajv)`. A name outside the pattern then fails to compile.
- **Matching.** A marked type matches only the same name. A `core.json-file` also compares its content schema. Unmarked
  values match by schema. An artifact never feeds a value port: a reader node turns it into one.
- **Content versus reference.** A marked artifact subschema's other keywords describe the file's content. The runtime
  value is an `ArtifactRef`, the reference to the file. The SDK's artifact port types, the worker protocol and the
  record all use it.

```ts
type ArtifactRef = {
  path: string;
  contentHash: string;
  producer?: { node: string; expansion: string };
};
```

- `path` is relative to the concert's artifact area. It uses forward slashes, has no leading `/`, and has no empty, `.`
  or `..` segment. It names a file or, for `core.dir`, a directory.
- `contentHash` is `sha256:` plus 64 lowercase hex digits. How a directory is hashed is the executor's, behind the same
  form.
- `producer` is the node instance that wrote the artifact: the node id and its expansion path
  ([Expansion paths](#expansion-paths)). It is absent only for an artifact from outside the concert, such as a param.

`artifactRefSchema` is its JSON Schema, closed to these fields and enforcing the path, hash and expansion rules. Every
boundary that reads a reference parses it against this one definition. `ARTIFACT_TYPES` are the names whose runtime
value is an `ArtifactRef`: every core type. `artifactsAsRefs(schema)` replaces each subschema one of them marks with
`artifactRefSchema`, so a validator checks a port's runtime value rather than the file's content.

`findMarked(schema, value)` returns one `{ type, schema, pointer, value }` per marked subschema whose value is present,
where `pointer` is a JSON Pointer into `value`. It never descends into a marked subschema, since that schema describes
content and not the reference. It descends:

- `properties`,
- `additionalProperties`, for keys that neither `properties` nor `patternProperties` claim,
- `items` and `prefixItems`,
- a `$ref` of the form `#` or `#/<pointer>`.

Nothing else. It never throws: any other `$ref` (an anchor, a remote ref, or one that does not resolve or decode) is not
followed.

`schemaMarkers(schema)` returns every marker in `schema`, each once, with the type it names, the JSON Pointer of the
subschema it marks, and whether `findMarked` reaches it. `unreachableMarkers(schema)` returns the pointer of each one
`findMarked` cannot reach:

- under any other keyword that holds subschemas (`allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`, `contains`,
  `propertyNames`, `patternProperties`, `dependentSchemas`, `unevaluatedItems`, `unevaluatedProperties`),
- behind a `$ref` it does not follow (an anchor naming a `$defs` entry),
- inside a marked subschema.

A `$defs` entry counts only when a `$ref` reaches it. An unreachable marker is a compose error (a `TYPE` diagnostic in
pre-flight), not a silent gap: compose reports each pointer this function returns.

## Plan

compose produces the plan. It is JSON, and `Plan` in `src/plan.ts` is its type. In V1 it is output only: perform takes
the IR, not a plan, so the plan carries no format version.

| Field         | Holds                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `ir`          | The IR, unchanged.                                                        |
| `expansion`   | Group id, then the group instance's expansion path, then its `Expansion`. |
| `bounds`      | `PlanBounds`, below.                                                      |
| `diagnostics` | Warnings only, each an ir `Diagnostic` (`src/types.ts`).                  |

Expansion paths are in the format of [Expansion paths](#expansion-paths) (`formatExpansion`): one `[key]` per enclosing
group, outermost first, `""` outside groups. A `parMap` or `parFind` item's key is its `itemKey`, or at perform a key
function's. Any other group's iteration key is its index.

An `Expansion` is either:

- `{ keys }`: the instance's iteration keys in order.
- `{ exact }`: a `parMap`'s iteration count, when its key function names the iterations at perform.
- `{ upTo }`: a region with its bound.

`PlanBounds` (D-23):

| Field       | Holds                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| `instances` | The node-instance total, groups included, as a `Cardinality`: `{ exact }` or `{ upTo }`.  |
| `nodes`     | Instances per node id.                                                                    |
| `counts`    | Each name a host's `bounds(node)` reports, times the node's instances, summed over nodes. |

A count is exact only when every group above it is a `parMap` whose items compose knows.

A plan for a `parMap` over two topics, then a loop, with a host that counts one `calls` per node and `ir` cut short:

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

## Events

`ConcertEvent` is one entry of a concert's event stream (CORE-10): the `NodeInstance` it is about (`node` and
`expansion`), `seq` (orders all events of a store and is the cursor to read after), `at` (epoch milliseconds) and an
`EventBody`, told apart by `type`:

| `type`     | Carries                                       | Means                                               |
| ---------- | --------------------------------------------- | --------------------------------------------------- |
| `running`  |                                               | The instance started.                               |
| `settled`  | `outcome`, optional `reason` and `enrichment` | It settled.                                         |
| `reused`   |                                               | A resume kept its `ok` record from before.          |
| `progress` | `event` (a `HostEvent`)                       | Its host emitted `event`, stored as given.          |
| `log`      | `line`                                        | Its worker wrote `line`, or its cancel hook failed. |

`HostEvent` and `Enrichment` are open JSON records that the host owns and the engine stores as given.

## Left to the consumers

The IR carries structure. These semantics belong to the slices that execute or validate it, and are not fixed here:

- how compose computes a plan and how perform produces events: ir fixes only their formats.

[^fanin]:
    A `fanin` node runs once every upstream has settled and receives each `data` input as `Settled`
    ([Outcomes](#outcomes)).

[^items]: Unless `items` is a literal.

[^timeout]:
    Whole milliseconds, from 1 to `MAX_TIMEOUT` (the longest timer delay), that an instance may take before it settles
    `failed`. None when absent.

## Changelog

- **1.1**: the `repo.agent` node config is `{ profile, seat, lane, verdict?, checks?, attachments?, out? }`. It lost
  `role`, `limits` and `readOnly`, and the node lost its `identity` input port. A 1.0 agent node is refused at
  pre-flight (ADR 0004, ADR 0013). Its `report` output became an object, `{ summary, gaps?, obstacles?, lessons? }`.
- **1.0**: first version. Before release, code nodes took the optional `timeout` and lost `pure`, and the `params` and
  `config` blocks left the IR. The node field `tag` was removed. The `repeat` kind became `loop`: it lost `until`,
  gained a required `test`, and its inner ports carry `ok` and `reason`. The implicit output `outcome` was removed: `ok`
  and `reason` are the status ports, and an edge from one admits a `rejected` source. The group kinds `map` and `seq`
  became `parMap`, `map` (in order), `find`, `parFind` and `fold`, `onError` became `stop` or `continue`, and a member
  with one result has that result's outputs as its value.
