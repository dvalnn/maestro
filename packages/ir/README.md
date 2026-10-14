# @maestro/ir

The IR is the language-neutral, versioned JSON form of a graph (D-09, IR-01). It is the contract between emitters (the
TypeScript SDK, or any other language) and the engine. This package holds:

- `ir.schema.json`: the published JSON Schema (draft 2020-12). It is the contract, and it is usable with any
  validator.
- `src/`: `parseIr`, `IR_VERSION`, `irSchema` and the TypeScript types, plus the shared contracts below: outcomes
  (`Outcome`, `Settled`, `worstOutcome`, `settledSchema`) and type markers (`MAESTRO_TYPE`, `CORE_TYPES`,
  `registerMaestroType`, `findMarked`, `unreachableMarkers`).
- `fixtures/`: golden hand-written IR files. Each one is accepted by `parseIr`.
- `test/read_ir.py`: an independent reader (Python standard library only), which proves the format is readable without
  maestro code.

```ts
import { parseIr } from "@maestro/ir";

const result = parseIr(JSON.parse(text));
if (!result.ok) console.error(result.diagnostics); // [{ code, path, message, hint? }]
```

`parseIr` checks the version first, then the schema, then the structural rules below. It never throws on bad input.

## Version and compatibility (CORE-16, ADR 0004)

`irVersion` is `"<major>.<minor>"`. This package reads and emits `1.0`.

- **Minor** changes are additive and optional: a new optional field, or a new value where readers already reject the
  unknown. IR written for `1.n` keeps its meaning under every later `1.m`.
- **Major** changes are anything else: a removed or renamed field, a new required field, a changed meaning, a new
  node or edge kind.
- A reader that supports `M.n` accepts `M.0` to `M.n`, and nothing else. It rejects another major, and a newer minor,
  with an `IR.version` diagnostic and a hint. Both checks come before the schema check, so IR of another major gets one
  clear error.
- So a 1.1 IR cannot be read by a 1.0 maestro. This is deliberate: an engine that silently ignored a field it does not
  know would perform the graph with the wrong meaning. The typical case is a pack that bundles a newer SDK than the
  `maestro` binary (D-30). The error says so and tells the operator to upgrade maestro.
- The schema's `irVersion` enum lists exactly the versions this package reads. It is bumped together with
  `IR_VERSION`, and a test checks that they agree.
- Any change to the IR updates the schema, the fixtures, `IR_VERSION` and the changelog at the end of this file
  (port plan rule 8).

## Document

| Field         | Content                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `irVersion`   | See above.                                                                                                    |
| `composition` | `id`, `version`, `pack`, optional `doc`.                                                                      |
| `emitter`     | `name` and `version` of what produced the IR, optional `sourceHash`. Hand-written IR uses `"hand"`.           |
| `params`      | The param `schema` (with CLI hints as schema annotations) and at least one entry in `examples` (D-17, D-19).  |
| `config`      | Optional. The config schema of each namespace the graph claims, with defaults (CFG-03).                      |
| `scopes`      | One per subcomposition use: `id`, `composition`, optional `parent`, and its `ports` with schemas.             |
| `nodes`       | Flat list. Nesting is by `parent`.                                                                            |
| `edges`       | Flat list, port to port.                                                                                      |
| `result`      | `{ "rule": "default" }` (CORE-04) or `{ "rule": "node", "node": id }` (an explicit node or a reducer).      |

Nodes and scopes share one id space. Ids are paths of `[A-Za-z0-9_-]` segments joined by `/`, derived by the emitter
from the scope path and label (IR-01). A `parent` names a scope or a group node. Scopes are for renderers, caches and
diagnostics and do not change execution. Groups do.

Every schema inside the IR (ports, params, config) is a JSON Schema document that the IR treats as opaque, except for
the `x-maestro-type` annotation that names artifacts and host types ([Type markers](#type-markers-x-maestro-type)).
Edge type checks are pre-flight's job (CORE-02), not this package's.

## Nodes

Common fields: `id`, `kind`, `label`, optional `tag` (a human label used in records, not an identity), `parent`,
`source` (`file`, `line`, `column`), `in` and `out` (port name to schema), and `literals` (port name to a plain value,
D-16).

Every node also has three implicit outputs: `outcome`, `ok` and `reason`. They may not be declared in `out`.

| Kind                     | Own fields                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `code`                   | `worker` `{runtime, module, export, codeHash}`, `pure`, optional `reads`, `writes`, `fanin` (a reducer, D-08).[^fanin] |
| `assert`                 | `message`, `onFail` (`rejected` or `failed`). The condition is an input port.                                     |
| `map`, `seq`, `repeat`   | Groups, below.                                                                                                    |
| `<host>.<kind>`          | Any kind with a dot is a host kind, with an optional opaque `config` object.                                      |

### Groups

A group's body is the nodes whose nearest enclosing group is the group. The body is a template that is instantiated per
item or iteration. Every group has:

- `members`: result name to body node id. A member result is a record with one entry per result name. A body with one
  result has one entry. A `map` may have several. A `seq` and a `repeat` take exactly one in 1.0, because their ports
  mirror that member's outputs. Allowing more later is a minor change.
- `cardinality`: `{ "exact": n }` or `{ "upTo": n }` (CORE-05),
- `inner`: ports the body reads, in addition to `in` and `out`.

| Kind     | `in`                                    | `inner`                  | `out`                       | Own fields                          |
| -------- | --------------------------------------- | ------------------------ | --------------------------- | ----------------------------------- |
| `map`    | `items`, unless `items` is a literal    | `item`                   | `results`                   | `items`, `key`, `onError` |
| `seq`    | `items`, unless `items` is a literal    | `item`                   | the member's outputs        | `items`, `until`                    |
| `repeat` | the member's outputs (initial state)    | member's outputs, `index`| the member's outputs        | `until`, `tolerate`                 |

- `items` is either a literal array on the node or an `items` input port fed by an edge, never both.
- A `map` over literal items is `exact` with the item count. Every other group is `upTo`, equal to the item count for a
  literal `seq`.
- `key` is an optional worker reference for an author key function (D-18).
- `onError` is `settle` or `propagate`, and has no default (ADR 0006).
- `until` is a body port `{node, port}` holding a boolean.
- `tolerate: "rejected"` on a `repeat` lets rejected state, including the initial state, carry into the next
  iteration.
- A `repeat`'s inner state ports hold the previous iteration's member outputs, or the initial state for the first
  iteration. At least one iteration runs, and `until` is read after each.
- A member result with several entries takes the worst entry outcome (ADR 0006).

## Edges

Every input port is fed exactly once, by a `data` or `collect` edge or by a literal.

| Kind      | From                     | To                      | Meaning                                                                            |
| --------- | ------------------------ | ----------------------- | ---------------------------------------------------------------------------------- |
| `data`    | `{node, port}`           | `{node, port}`          | A value or artifact flows.                                                         |
| `collect` | a map's `results` port   | `{node, port}`          | The settled member results flow, as the explicit fan-in (CORE-03, D-08).           |
| `control` | `{node, port}`           | `{node}`                | A guard. The target proceeds only when the boolean port is true, else it is skipped. |
| `control` | `{node}`                 | `{node}`                | Ordering. It may carry `tolerate: "rejected"` to admit a rejected upstream.        |

A dependent starts only after every upstream it has an edge from is `ok`, unless a control edge from that upstream
tolerates `rejected` (CORE-04).

The edge source decides which ports a group exposes. Seen from inside its body, a group exposes `inner`. From
anywhere else, it exposes `out` and the implicit outputs.

## Structural rules

Enforced by `parseIr` after the schema:

1. Ids are unique across nodes and scopes (`SCOPE.duplicate`).
2. Every `parent`, edge endpoint, port, literal, member, `until` and result node resolves (`IR.ref`).
3. Parent chains do not loop. An edge never leaves a group body: only the group's `out` ports reach outside it.
4. Every input port is fed exactly once.
5. `collect` edges start only at a map's `results` port, and that port feeds nothing else.
6. Group ports, `members`, `until`, `items` and `cardinality` follow the group rules above.
7. The result node is not inside a group body.
8. Edges form no cycle. An edge into a body counts as an edge into its group.

Violations of rules 3 to 8 are `IR.graph`. Shape violations are `IR.schema`, and version problems are `IR.version`.

## Outcomes

A node settles `ok`, `rejected`, `failed` or `skipped` (`Outcome`, CORE-04). A settled value is `Settled<T>`:

```ts
type Settled<T> =
	| { outcome: "ok"; value: T }
	| { outcome: "rejected" | "failed"; value?: T; reason: string }
	| { outcome: "skipped"; value?: T; reason?: string };
```

`worstOutcome(outcomes)` is the one rule wherever several outcomes collapse into one: `failed` > `rejected` >
`skipped` > `ok`, and an empty input is `ok` (ADR 0006). It decides a `map` member with several results and a `map`
with `onError: "propagate"`. `firstOk` with no `ok` input first counts `skipped` inputs as `rejected`, then takes the
worst.

`settledSchema(T)` is the JSON Schema of `Settled<T>`, closed to `outcome`, `value` and `reason`:

- `ok` requires `value` and has no `reason`.
- `rejected` and `failed` require `reason`, and `value` is optional.
- `skipped` has both optional.

T sits at `properties.value`. Port schemas describe the delivered value, so:

- a map's `results` port, and every input fed by a `collect` edge, declare an array whose `items` is
  `settledSchema(T)`,
- a fan-in node's input fed by a `data` edge declares `settledSchema(T)`.

The golden fixtures do so with T `{ "type": "object" }`, the member result record, and a test keeps them equal to
`settledSchema`'s output.

**Fan-in edge rule.** A `data` edge into a fan-in input checks the upstream port's schema against the input's
`properties.value` subschema, not against the whole `Settled` schema (ADR 0006).

## Type markers (`x-maestro-type`)

The annotation names an artifact or host type on any subschema of a port, param or scope port (ADR 0007):

```json
{ "type": "array", "items": { "x-maestro-type": "core.file" } }
```

- **Namespaces.** A name is `<namespace>.<type>`, the pattern host node kinds use (`$defs/qualifiedName` in
  `ir.schema.json`). Core owns `core.file`, `core.dir`, `core.json-file` and `core.markdown` (`CORE_TYPES`). Each host
  owns its own namespace.
- **Registration.** Ajv's strict mode rejects unknown keywords, so whatever compiles port schemas calls
  `registerMaestroType(ajv)`. A name outside the pattern then fails to compile.
- **Matching.** A marked type matches only the same name. A `core.json-file` also compares its content schema.
  Unmarked values match by schema. An artifact never feeds a value port: a reader node turns it into one.
- **Content versus reference.** A marked artifact subschema's other keywords describe the file's content. The runtime
  value is the reference to the file, whose shape core fixes.

`findMarked(schema, value)` returns one `{ type, schema, pointer, value }` per marked subschema whose value is
present, where `pointer` is a JSON Pointer into `value`. It never descends into a marked subschema, since that schema
describes content and not the reference. It descends:

- `properties`,
- `additionalProperties`, for keys that neither `properties` nor `patternProperties` claim,
- `items` and `prefixItems`,
- a `$ref` of the form `#` or `#/<pointer>`.

Nothing else. It never throws: any other `$ref` (an anchor, a remote ref, or one that does not resolve or decode) is
not followed.

`unreachableMarkers(schema)` returns the JSON Pointer into `schema` of every marker `findMarked` cannot reach:

- under any other keyword that holds subschemas (`allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`, `contains`,
  `propertyNames`, `patternProperties`, `dependentSchemas`, `unevaluatedItems`, `unevaluatedProperties`),
- behind a `$ref` it does not follow (an anchor naming a `$defs` entry),
- inside a marked subschema.

A `$defs` entry counts only when a `$ref` reaches it. An unreachable marker is a compose error (a `TYPE` diagnostic in
pre-flight), not a silent gap: compose reports each pointer this function returns.

## Left to the consumers

The IR carries structure. These semantics belong to the slices that execute or validate it, and are not fixed here:

- compose-time additions such as folded values, expansion and bounds (the plan).

[^fanin]: A `fanin` node runs once every upstream has settled and receives each `data` input as `Settled`
    ([Outcomes](#outcomes)).

## Changelog

- **1.0**: first version.
