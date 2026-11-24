---
status: accepted
---

# Port schemas are named once in the IR

A `classics.build_then_review` plan has 393 port schemas, but only 18 distinct ones. They take half of the full
`compose --json` document. IR 1.3 (`packages/ir`) names each schema once.

1. **A schemas table in the IR format.** The IR gains an optional top-level `schemas` table, a key and then a JSON
   Schema document. Any port map may hold a key in place of an inline schema: a node's `in`, `out` and `inner`, and a
   scope's `ports`. One IR may mix both.
2. **A string key.** A port schema is an opaque JSON Schema document, where `$ref` already has a meaning. A string was
   never a valid port schema, so a key cannot be mistaken for an authored schema. The key spelling is the writer's.
3. **The loaded IR is the inline IR.** `parseIr` resolves each key after the shape check and drops the table. The `Ir`
   type does not change, so every reader past it, the record and the perform fingerprint included, sees what an inline
   file gives.
4. **One writer rule.** The CLI writes the shared form at its two IR writers: the full `compose --json` document and
   `compose --out`. It puts every port schema in the table, even one used once. Schemas with equal canonical JSON share
   one entry.
5. **A minor version.** The field is new and optional, and a 1.2 reader already rejects a string port, so it is 1.3 by
   [ADR 0004](0004-ir-flat-graph-and-version-policy.md). The SDK emits the current version, so its IR declares 1.3 even
   with inline schemas.

## Considered options

- **A table in the CLI document only.** A `schemas` table beside `plan`, with the ports in `plan.ir` holding keys into
  it. The saving is the same for `compose --json`, but `plan.ir` stops being an IR. A script that saves it as an IR file
  must first rebuild it, and `--out` files keep their size. Rejected for one format that the IR README documents.
- **JSON Schema `$ref`s into `$defs`.** Standard, but a port schema may hold its own `$ref`. A reader could not tell an
  authored reference from a shared one. Rejected for a string key.
- **Leave `irVersion` out of the perform fingerprint.** It would keep the fingerprints of 1.2 concerts, but it would
  move every stored fingerprint once anyway. Rejected.

## Consequences

- The full `compose --json` document and `--out` files drop to about half their size, and both still load as IR.
- A script that reads a port schema from `plan.ir` looks it up in `plan.ir.schemas`.
- An older maestro refuses every IR this one emits, with its upgrade hint.
- An encore rebuilds its composition as 1.3, so the first encore of a concert performed under 1.2 runs even when nothing
  else changed.
- The record's `concerts.ir`, the SDK's emitted IR and schemas inside a host node's `config` keep inline schemas.
