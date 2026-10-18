---
status: accepted
---

# Code nodes name exported functions, resolved by the loader

A code node's IR names its function as `worker: {runtime, module, export, codeHash}`. That reference must survive
everything that happens after build: a concert runs them in another process on resume (CORE-09), hand-written IR runs
with no SDK (IR-01, AC-8), and the resume key covers `codeHash` (CORE-09). A function value carries none of this, and a
lambda or closure cannot be found again from the IR.

**Naming.** Every function the SDK turns into a code node is a named export of a module that can be imported again after
build:

- `code(fn)` makes one code node whose worker is `fn`.
- A `map` key function is a worker reference on the group (IR `key`).
- A predicate that needs code, such as an `until` that is not a Ref expression, is an exported code node.

Build-time values reach a code node as `literals` (D-16), never through a closure, so the resume key sees them.

**One call shape.** Every code function is `(inputs, ctx) => outputs | Rejection`, or a promise of either, with inputs
and outputs keyed by port name, so the worker calls each the same way and the worker reference needs no field saying
how:

- `Rejection` and `reject(reason, outputs?)` live in `packages/ir`. A rejection's outputs sit in its own `outputs`
  field, never beside `outcome` or `reason`, so a rejection is never mistaken for outputs. When given, they are the
  node's full outputs, checked against its `out` schemas like an `ok` node's, so a tolerant consumer reads a code
  verdict's findings as it reads a host's.
- The SDK types `code()` so the function is checked against its declared ports at compile time, and a function that can
  reject shows it in its inferred return type.
- A `map` key function is `(item) => key`. It names members and is not a node.

**Resolution is the loader's.** The loader that loads a composition owns both directions:

- `resolveCode(fn)`, supplied to the build context, returns the worker reference for `fn`, or nothing when `fn` is not
  an export it can name. It is deterministic (CORE-06). The SDK calls it for every function it turns into a code node,
  and knows nothing of packs, files or hashing.
- Nothing returned is a build diagnostic that names the function's source position and says to export it.
- `loadCode(ref)` returns the function a worker reference names, for the worker and for compose's check that it
  resolves. What `module` is relative to, for a pack bundle, a bare composition file and an IR file, is the loader's.
  For an IR file it checks the module against `codeHash` and errors when they differ, so a stale hand-written hash never
  lets a resume reuse a stale result.
- A function a pack takes from another pack's subcomposition is part of the using pack's bundle (ADR 0002), so `fn`
  alone identifies it.

**`codeHash`.** It changes whenever any code the function reaches changes, so a resume never reuses a result a changed
helper would alter. A loader may hash more than that, such as a whole bundle, which costs reuse but is never stale. Each
loader's form is `sha256:` and the hex SHA-256 of:

- a pack: its entry file's bytes, the whole bundle. `module` is the entry's path relative to the pack directory.
- a bare composition file: the file bundled in memory, its SDK import mapped to the engine's. `module` is the file's
  name.
- an IR file: the module file's bytes. `module` is relative to the IR file's directory.

The loader imports the bytes it hashed, so what runs is what the hash names. A pack entry or IR-file module that imports
anything but builtins and `@maestro/sdk` is refused, since its bytes would not be all the code it reaches.

**Standard library.** Stdlib code nodes, such as `firstOk`, use the reserved module `maestro:stdlib`. The SDK emits them
directly, without `resolveCode`. The loader resolves the module to the stdlib of the SDK the engine embeds, never to a
copy bundled in a pack, so their behaviour is the engine's, versioned with it:

- Their `codeHash` is `maestro:stdlib@<semver>`, the one form that is not a content hash. The IR schema pairs it with
  the `maestro:stdlib` module both ways. The version is the building SDK's and is informational.
- The resume key holds the stdlib version the engine will run, so an engine upgrade invalidates them.
- A stdlib export the engine does not have is a compose error.

Build-time callbacks that only shape the graph, such as a `map` body, a `repeat` step or an `until` that returns a Ref,
run during build and are not code nodes.

## Considered options

- **Rebuild on perform and look functions up by node id.** Lambdas and closures would work. Rejected: perform would
  depend on rebuilding, IR alone would not run (AC-8), and values a closure captures stay invisible to the resume key.
- **Explicit names**, such as `code("byFinding", fn)`. No lookup, but the author keeps a name and an export in step by
  hand, and a mismatch shows up only at perform.
- **`ref.map(fn)` handing `fn` the bare value.** Reads like `Array.map`, but it is a second call shape the IR cannot
  tell apart from the first, a returned rejection looks like a value, and it takes one input only. Rejected, and
  `ref.map` with it.
- **A result wrapper**, `ok(outputs)` in the manner of Rust's `Result`. The union `outputs | Rejection` already is the
  sum type, and a wrapper taxes every function that never rejects. A throw, settling `failed`, stays outside any return
  type either way.
- **`codeHash` from `fn.toString()`.** Changes only with the function's own text. Rejected: blind to the helpers it
  calls, so a changed helper lets a resume reuse stale results.
- **The SDK resolves packs itself**, from a pack entry namespace the build context hands it. Ties the SDK to the pack
  format, and bare files, hand-written IR and functions taken from another pack each need a rule inside the SDK.

## Consequences

- Authors export every function a code node runs. A field read is `ref.get(path)`, and anything else is a `code` node.
- SDK tests resolve through a test resolver. The loader's rules are tested where the loader lands.
- The worker reply gains an additive field for the stdlib version it ran (CORE-14), so older workers stay valid and the
  resume key and the record can key on it.
- No IR change expected: the fields keep their names and types. `maestro:stdlib` is a reserved `module` value, and the
  golden fixtures move their stdlib reducers to it.
