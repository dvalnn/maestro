---
status: accepted
---
# Code nodes name exported functions, resolved by the loader

A code node's IR names its function as `worker: {runtime, module, export, codeHash}`. That reference must survive
everything that happens after build: compose folds pure code nodes, a concert runs them in another process on resume
(CORE-09), hand-written IR runs with no SDK (IR-01, AC-8), and the cache keys on `codeHash` (CORE-09). A function
value carries none of this, and a lambda or closure cannot be found again from the IR.

**Naming.** Every function the SDK turns into a code node is a named export of a module that can be imported again
after build:

- `code(fn)` and `ref.map(fn)` each make one code node whose worker is `fn`.
- A `map` key function is a worker reference on the group (IR `key`).
- A predicate that needs code, such as an `until` that is not a Ref expression, is an exported code node.

Build-time values reach a code node as `literals` (D-16), never through a closure, so the cache sees them.

**Resolution is the loader's.** The loader that loads a composition owns both directions:

- `resolveCode(fn)`, supplied to the build context, returns the worker reference for `fn`, or nothing when `fn` is
  not an export it can name. It is deterministic (CORE-06). The SDK calls it for every function it turns into a code
  node, and knows nothing of packs, files or hashing.
- Nothing returned is a build diagnostic that names the function's source position and says to export it.
- `loadCode(ref)` returns the function a worker reference names, for the worker and for compose folding. What
  `module` is relative to, for a pack bundle, a bare composition file and an IR file, is the loader's. For an IR
  file it checks the module against `codeHash` and errors when they differ, so a stale hand-written hash never
  serves a cached result.
- A function a pack takes from another pack's subcomposition is part of the using pack's bundle (ADR 0002), so `fn`
  alone identifies it.

**`codeHash`.** It changes whenever any code the function reaches changes, so a changed helper never serves a stale
cached result. A loader may hash more than that, such as a whole bundle, which costs cache hits but is never stale. How
each loader forms it is recorded when the loader lands.

**Standard library.** Stdlib code nodes, such as `firstOk`, use the reserved module `maestro:stdlib`. The SDK emits
them directly, without `resolveCode`. The loader resolves the module to the stdlib of the SDK the engine embeds, never
to a copy bundled in a pack, so their behaviour is the engine's, versioned with it:

- Their `codeHash` is `maestro:stdlib@<semver>`, the one form that is not a content hash. The IR schema pairs it
  with the `maestro:stdlib` module both ways. The version is the building SDK's and is informational.
- The cache keys a stdlib node on the stdlib version the engine will run, so an engine upgrade invalidates them.
- A stdlib export the engine does not have is a compose error.

Build-time callbacks that only shape the graph, such as a `map` body, a `repeat` step or an `until` that returns a
Ref, run during build and are not code nodes.

## Considered options

- **Rebuild on perform and look functions up by node id.** Lambdas and closures would work. Rejected: perform would
  depend on rebuilding, IR alone would not run (AC-8), and values a closure captures stay invisible to the cache.
- **Explicit names**, such as `code("byFinding", fn)`. No lookup, but the author keeps a name and an export in step
  by hand, and a mismatch shows up only at perform.
- **`codeHash` from `fn.toString()`.** Changes only with the function's own text. Rejected: blind to the helpers it
  calls, so a changed helper serves stale cached results.
- **The SDK resolves packs itself**, from a pack entry namespace the build context hands it. Ties the SDK to the pack
  format, and bare files, hand-written IR and functions taken from another pack each need a rule inside the SDK.

## Consequences

- Authors export every function a code node runs. `ref.map(x => x.foo)` becomes `ref.pick("foo")` or a named export.
- SDK tests resolve through a test resolver. The loader's rules are tested where the loader lands.
- The worker reply gains an additive field for the stdlib version it ran (CORE-14), so older workers stay valid and
  the cache and the record can key on it.
- No IR change expected: the fields keep their names and types. `maestro:stdlib` is a reserved `module` value, and the
  golden fixtures move their stdlib reducers to it.
