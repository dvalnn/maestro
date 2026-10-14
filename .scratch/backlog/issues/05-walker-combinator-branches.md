# The `x-maestro-type` walker does not look under schema combinators

Status: needs-triage

Owner ruling 2026-10-15: V1 walks `properties`, `additionalProperties`, `items`, `prefixItems` and local `$ref` only
(YAGNI). A marker under `anyOf`, `oneOf`, `allOf`, `if`/`then`/`else` or `not` is not found (ADR 0007).

Reach for this when a port needs a marked type inside a combinator, for example `Maybe(T)` emitted as
`anyOf: [T, null]`, or a union of artifact kinds.

Candidate fix: descend into the branches the value validates against, which needs a per-branch Ajv check in the
walker.

Owner ruling 2026-10-15 (D2): the walker never throws. A marker it cannot reach, whether under a combinator, behind an
anchor, remote or unresolvable `$ref`, or inside a marked subschema, is a `TYPE` compose error in pre-flight, through
the reachability check `packages/ir` exports. Valid but unsupported schema features fail before spend, not silently.
