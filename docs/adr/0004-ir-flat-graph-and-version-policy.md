---
status: accepted
---

# The IR is a flat graph with explicit group ports, versioned major.minor

IR 1.0 (`packages/ir`, CORE-16, IR-01) fixes three things that every emitter and consumer builds on.

1. **Versioning.** `irVersion` is `"<major>.<minor>"`. Minor versions are additive and optional. A reader at `M.n`
   accepts `M.0` to `M.n`, and rejects another major or a newer minor with a clear error before any schema check. So a
   1.1 IR cannot be read by a 1.0 engine. The usual cause is a pack that bundles a newer SDK than the `maestro` binary
   (D-30), and the error tells the operator to upgrade maestro. The schema's `irVersion` enum and `IR_VERSION` are
   bumped together.
2. **Flat graph.** Nodes, scopes and edges are flat lists, and nodes and scopes share one id space. Nesting is the id
   itself: an id is a path, each proper prefix of it a declared scope or group node, and its last segment the node's
   name. Scopes are presentation and cache structure. Only groups change execution.
3. **Explicit group ports.** A group declares `in`, `inner` (what its body reads: `item`, or a `repeat`'s previous state
   and `index`) and `out` (what leaves it: a map's `results`, or a `seq`/`repeat` member's outputs). It names its
   `members` (result name to body node, several for a map body that returns several results) and its `until` node in the
   body. Edges never leave a body except through the group's `out`. Fan-in is a `collect` edge from a map's `results`.
   Guards and tolerance are `control` edges, as architecture section 5 says.

## Considered options

- **Nested bodies** (a group node containing its own `nodes` and `edges`). Closer to the source shape, but every reader
  then needs a recursive walk and a second edge scope, and edges into a body from outside need cross-level references
  anyway. Rejected for the flat list, where one id space and one edge list serve renderers, caches and the validator.
- **Readers accept newer minors and ignore unknown fields.** Forward compatible, but a closed schema could no longer
  catch typos in hand-written IR, and an older engine would silently drop a field whose meaning matters. Rejected. An
  older maestro tells the operator to upgrade instead.
- **`tolerate` on data edges.** Fewer edges, but it contradicts architecture section 5, which puts tolerance on control
  edges. Kept as the architecture says.
- **Selecting a `seq`/`repeat` result field by a field-read code node.** Uniform, but a Result handle's ports are
  structure, not data (sdk-spec section 5). A host value such as a handle that may be consumed only once would then pass
  through a code node. Rejected for mirrored ports.

## Consequences

- The IR has no default for `map.onError`, and neither has the SDK (ADR 0006).
- A `map` member result is a record keyed by result name, which covers the object-returning bodies of sdk-spec
  section 14. A `seq` or `repeat` takes exactly one member in 1.0, because its ports mirror that member. Allowing
  several later relaxes a rule and is a minor change.
- A fan-in over non-ok inputs (`firstOk([a, b])`, where `a` may be skipped) needs no edge marker: a `fanin` node
  receives its inputs as `Settled` (ADR 0006).
- `tolerate` is the scalar `"rejected"`. Only `rejected` is ever tolerable (CORE-04), so an array would only add a shape
  to validate.
- Compose-time additions (expansion, bounds) are not in 1.0. The plan slice adds them as a minor version.
