# @maestro/ir

The IR is the language-neutral, versioned JSON form of a graph (D-09, IR-01). It is the contract between emitters (the
TypeScript SDK, or any other language) and the engine. ir holds the IR plus what the SDK and core must both see, since
the SDK imports nothing else (ADR 0007). It depends on nothing beyond Ajv. This package holds:

- `ir.schema.json`: the published JSON Schema (draft 2020-12). It is the contract, and it is usable with any validator.
- `src/`: `parseIr`, `IR_VERSION`, `irSchema` and the TypeScript types, plus the shared contracts below: diagnostics
  (`Diagnostic`, `Severity`), outcomes (`OUTCOMES`, `Outcome`, `Settled`, `worstOutcome`, `settledSchema`), the
  code-function contract (`Context`, `CodeContext`, `Facts`, `Rejection`, `reject`, `TS_RUNTIME`), type markers
  (`MAESTRO_TYPE`, `CORE_TYPES`, `ARTIFACT_TYPES`, `registerMaestroType`, `findMarked`, `schemaMarkers`,
  `unreachableMarkers`, `artifactsAsRefs`), artifact references (`ArtifactRef`, `artifactRefSchema`), the graph index
  (`indexGraph`, `GraphIndex`, `IMPLICIT_OUT`, `outputValue`, `isGroup`, `boundOf`, `tolerates`), expansion paths
  (`itemKey`, `firstDuplicate`, `formatExpansion`, `parseExpansion`, `formatInstance`) and `MAX_TIMEOUT`.
- `fixtures/`: golden hand-written IR files. Each one is accepted by `parseIr`, and its worker modules sit beside it.
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

`irVersion` is `"<major>.<minor>"`. This package reads and emits `1.0`.

- **Minor** changes are additive and optional: a new optional field, or a new value where readers already reject the
  unknown. IR written for `1.n` keeps its meaning under every later `1.m`.
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

Every node also has three implicit outputs: `outcome`, `ok` and `reason`, whose schemas are `IMPLICIT_OUT`. They may not
be declared in `out`. `outputValue(settled, outputs, port)` reads any port of a settled node, implicit or declared.

| Kind                   | Own fields                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `code`                 | `worker` `{runtime, module, export, codeHash}`, optional `reads`, `writes`, `fanin` (a reducer, D-08),[^fanin] `timeout`.[^timeout] |
| `assert`               | `message`, `onFail` (`rejected` or `failed`). The condition is an input port.                                                       |
| `map`, `seq`, `repeat` | Groups, below.                                                                                                                      |
| `<host>.<kind>`        | Any kind with a dot is a host kind, with an optional opaque `config` object.                                                        |

### Groups

A group's body is the nodes whose nearest enclosing group is the group. The body is a template that is instantiated per
item or iteration. Every group has:

- `members`: result name to body node id. A member result is a record with one entry per result name. A body with one
  result has one entry. A `map` may have several. A `seq` and a `repeat` take exactly one in 1.0, because their ports
  mirror that member's outputs. Allowing more later is a minor change.
- `cardinality`: `{ "exact": n }` or `{ "upTo": n }` (CORE-05),
- `inner`: ports the body reads, in addition to `in` and `out`.

| Kind     | `in`                                 | `inner`                   | `out`                | Own fields                |
| -------- | ------------------------------------ | ------------------------- | -------------------- | ------------------------- |
| `map`    | `items`, unless `items` is a literal | `item`                    | `results`            | `items`, `key`, `onError` |
| `seq`    | `items`, unless `items` is a literal | `item`                    | the member's outputs | `items`, `until`          |
| `repeat` | the member's outputs (initial state) | member's outputs, `index` | the member's outputs | `until`, `tolerate`       |

- `items` is either a literal array on the node or an `items` input port fed by an edge, never both.
- A `map` over literal items is `exact` with the item count. Every other group is `upTo`, equal to the item count for a
  literal `seq`.
- `key` is an optional worker reference for an author key function (D-18).
- `onError` is `settle` or `propagate`, and has no default (ADR 0006).
- `until` is a body port `{node, port}` holding a boolean.
- `tolerate: "rejected"` on a `repeat` lets rejected state, including the initial state, carry into the next iteration.
- A `repeat`'s inner state ports hold the previous iteration's member outputs, or the initial state for the first
  iteration. At least one iteration runs, and `until` is read after each.
- A member result with several entries takes the worst entry outcome (ADR 0006).

## Edges

Every input port is fed exactly once, by a `data` or `collect` edge or by a literal.

| Kind      | From                   | To             | Meaning                                                                              |
| --------- | ---------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `data`    | `{node, port}`         | `{node, port}` | A value or artifact flows.                                                           |
| `collect` | a map's `results` port | `{node, port}` | The settled member results flow, as the explicit fan-in (CORE-03, D-08).             |
| `control` | `{node, port}`         | `{node}`       | A guard. The target proceeds only when the boolean port is true, else it is skipped. |
| `control` | `{node}`               | `{node}`       | Ordering. It may carry `tolerate: "rejected"` to admit a rejected upstream.          |

A dependent starts only after every upstream it has an edge from is `ok`, unless a control edge from that upstream
tolerates `rejected` (CORE-04). `tolerates(node, edge)` is this rule for one edge into `node`: a control edge by its own
`tolerate`, any other edge by the `tolerate` of a `repeat`.

The edge source decides which ports a group exposes. Seen from inside its body, a group exposes `inner`. From anywhere
else, it exposes `out` and the implicit outputs.

## Structural rules

Enforced by `parseIr` after the schema:

1. Ids are unique across nodes and scopes (`SCOPE.duplicate`).
2. Every proper prefix of an id is a declared scope or group node.
3. Every edge endpoint, port, literal, member, `until` and result node resolves (`IR.ref`).
4. An edge never leaves a group body: only the group's `out` ports reach outside it.
5. Every input port is fed exactly once.
6. `collect` edges start only at a map's `results` port, and that port feeds nothing else.
7. Group ports, `members`, `until`, `items` and `cardinality` follow the group rules above.
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
and empty outside groups. A `map` contributes its item's key, a `seq` or `repeat` its iteration index, so the path of a
node in a `repeat` inside a `map` reads `[risk][2]`.

- `itemKey(item, index)` is a `map` item's key (D-18): a string, number, boolean or `null` item is keyed by its value,
  any other item by its index. Each character outside `[A-Za-z0-9_.-]` becomes `_`. Keys that come out equal are
  duplicates, so `3` and `"3"` collide; the caller reports them. `firstDuplicate(keys)` finds the first repeat.
- `formatExpansion(keys)` builds the path and throws on a key outside that alphabet. `parseExpansion(path)` returns the
  keys, or `undefined` for anything else. A key may be empty (`[]`), as `itemKey("")` is.
- `formatInstance(instance, groups)` merges an instance into one name, each key right after its group's id within the
  node id, given the node's enclosing groups: `lens/skeptic` in the map `lens` shows as `lens[risk]/skeptic`.

## Outcomes

A node settles `ok`, `rejected`, `failed` or `skipped` (`Outcome`, CORE-04). A settled value is `Settled<T>`:

```ts
type Settled<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "rejected" | "failed"; value?: T; reason: string }
  | { outcome: "skipped"; value?: T; reason?: string };
```

`worstOutcome(outcomes)` is the one rule wherever several outcomes collapse into one: `failed` > `rejected` >
`skipped` > `ok`, and an empty input is `ok` (ADR 0006). It decides a `map` member with several results and a `map` with
`onError: "propagate"`. `firstOk` with no `ok` input first counts `skipped` inputs as `rejected`, then takes the worst.

`settledSchema(T)` is the JSON Schema of `Settled<T>`, closed to `outcome`, `value` and `reason`:

- `ok` requires `value` and has no `reason`.
- `rejected` and `failed` require `reason`, and `value` is optional.
- `skipped` has both optional.

T sits at `properties.value`. Port schemas describe the delivered value, so:

- a map's `results` port, and every input fed by a `collect` edge, declare an array whose `items` is `settledSchema(T)`,
- a fan-in node's input fed by a `data` edge declares `settledSchema(T)`.

The golden fixtures do so with T `{ "type": "object" }`, the member result record, and a test keeps them equal to
`settledSchema`'s output.

**Fan-in edge rule.** A `data` edge into a fan-in input checks the upstream port's schema against the input's
`properties.value` subschema, not against the whole `Settled` schema (ADR 0006).

## Code functions

`src/code-function.ts` is the code-function contract, kept in one module so it can leave ir in one step:

- `Context`: what core gives every node instance, `concert` (the concert id), `clock`, `path(ref)` and `scratch`, the
  instance's own scratch directory (ADR 0007).
- `CodeContext`: `Context` plus `env`, each host's `Facts` keyed by host name, and `log(line)`, which records `line` as
  a `log` event on the instance.
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

## Left to the consumers

The IR carries structure. These semantics belong to the slices that execute or validate it, and are not fixed here:

- compose-time additions such as expansion and bounds (the plan).

[^fanin]:
    A `fanin` node runs once every upstream has settled and receives each `data` input as `Settled`
    ([Outcomes](#outcomes)).

[^timeout]:
    Whole milliseconds, from 1 to `MAX_TIMEOUT` (the longest timer delay), that an instance may take before it settles
    `failed`. None when absent.

## Changelog

- **1.0**: first version. Before release, code nodes took the optional `timeout` and lost `pure`, and the `params` and
  `config` blocks left the IR.
