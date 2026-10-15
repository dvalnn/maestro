---
status: accepted
---
# Port schemas name artifacts and host types with `x-maestro-type`

At runtime every artifact is the same small record (path, content hash, producer), and a host value such as a lane
handle is a record of strings. Structure alone cannot tell a Markdown report from a findings file or a lane, yet
compose must type-check edges between them (CORE-02), the cache must hash artifact contents, hosts must stage
artifacts into a sandbox, and a host's `validate` hook must find its handles wherever they travel.

A JSON Schema annotation names the type, on any subschema of a port, param or scope port:

```json
{ "x-maestro-type": "agents.lane" }
{ "x-maestro-type": "core.json-file", "type": "array", "items": { "...": "Findings" } }
{ "type": "array", "items": { "x-maestro-type": "core.file" } }
```

- Values are `<namespace>.<type>`, the naming the IR already uses for host node kinds. Core owns `core.file`,
  `core.dir`, `core.json-file` and `core.markdown`. Each host owns its own namespace.
- A marked type matches only the same name. A `core.json-file` also compares its content schema. Unmarked values match
  by schema.
- An artifact never feeds a value port. A reader node turns it into a value, visible in the graph (sdk-spec section 5).
- An artifact port's schema describes the file's content. The runtime value is the reference, `ArtifactRef` in
  `packages/ir`: the SDK types artifact ports with it, and the SDK shares only `ir` with core. So `ir` holds the IR plus
  whatever the SDK and core must both see, and depends on nothing beyond Ajv.
- A node writes a file or directory under its own scratch directory, `ctx.scratch`, and hands it back as a plain
  absolute path at an artifact output. An object there is an `ArtifactRef` passed on. When the node finishes, core
  moves each written path into the concert's artifact area and hashes it, the output then holds its `ArtifactRef`, and
  the scratch directory is deleted. A node reads an input artifact in place, through `ctx.path(ref)`.
- `packages/ir` owns the keyword's name, its Ajv registration and the one walker that finds marked subschemas in a
  schema and value pair. The SDK emits the annotation. Compose, the cache, host staging and host validation call the
  walker.

## Considered options

- **Structure only.** Cannot tell artifacts or host types apart. Rejected.
- **A `type` field on each port in the IR.** Visible to every IR reader, but it covers only the top level of a port,
  while artifacts and lanes sit inside lists, records, map results and agent results. Nesting would need the in-schema
  marker anyway, and the field costs an IR 1.1 bump. Rejected.
- **A written file as `{ written: path }`.** The port's marker already says the value is an artifact, so a string
  there can only be a new file. One shape fewer.
- **Nodes make their own temporary directories.** Nothing cleans them up, and a full temporary directory fails every
  later concert on that host, as the predecessor found.

## Consequences

- No IR change. Port schemas stay opaque to `packages/ir` except for this keyword.
- Ajv's strict mode rejects unknown keywords, so every place that compiles port schemas registers the keyword through
  `packages/ir`.
- The content-versus-reference reading of an artifact schema is documented once, in `packages/ir`.
- Core owns where scratch directories live. Making that root configurable comes later.
