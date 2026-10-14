# Calls for the owner, wave 3

Accumulated by the conductor overnight on 2026-10-15. Each call has a tag to answer by, the options, and the
conductor's recommendation. Nothing listed here has been decided or dispatched.

## Blocking the core-seams slice (S34), and so S3 and S4

**[C1] CORE-12's word list vs the host interface.** CORE-12's scan rejects `run` and `build` in core packages.
Architecture 6 names the host kind hook `run(instance, inputs, context)`, and D-23 bounds count "agent runs".
- A. Name the hook `execute`, and say "build" only outside core (the SDK builds, core composes). *(recommended)*
- B. Narrow CORE-12's scan to the domain words that matter (lane, seat, leg, review, quality) and keep `run`/`build`.

**[C2] Where the graph index lives.** `packages/ir/src/graph.ts` already builds a private index (nodes, parents,
ancestors, enclosing groups) for `checkGraph`. S3 and S4 need the same lookups.
- A. Extract it into a small exported index in `packages/ir`, which `checkGraph`, S3 and S4 all use. *(recommended:
  no duplicate, and ir already owns the structural rules)*
- B. Core builds its own in the core-seams slice. Architecture 3 gives core the "graph model", but it duplicates ir's.

**[C3] `bounds(node)` without the word "agent".** D-23 bounds node instances and agent runs. Core cannot name agents.
- A. `bounds` returns named counts, like metrics (CORE-19). Core sums each name, and core config caps them by name.
  The agent host returns `{ "agents.runs": n }`. *(recommended)*
- B. A fixed second field with a neutral name, such as `hostUnits`.

## Carved out of S2 (S2 runs without them)

**[S2-Q1] Derived metadata (SDK-06).** "Composition metadata derives from the graph", but the IR has no metadata field,
and the predecessor's examples (roles used, whether checks run) are host concepts.
- A. A function over IR in the SDK (kinds and host namespaces used), computed on demand, never stored. *(recommended)*
- B. An IR field, which is an IR 1.1 change.
- C. Drop it from the SDK; the CLI or the host derives what it shows.

**[S2-Q2] Config namespaces a pack or composition claims (CFG-03, architecture 8).** The IR has `config`, but sdk-spec
gives no SDK API to claim a namespace.
- A. Wait for S6 (config) to define the claim API; S2 emits `params` only. *(recommended)*
- B. Design it in S2 now.

**[S2-Q3] CLI hints on params (sdk-spec 9: flag name, description, repeatable, required, default).** Standard JSON
Schema covers description, default, required and repeatable (an array). A flag name other than the param's own needs a
custom keyword, registered like `x-maestro-type`.
- A. Standard keywords only; the flag is the param name. S6 adds a keyword if it needs one. *(recommended)*
- B. Define `x-maestro-flag` (and short aliases) now.

**[S2-Q4] How a declared `Maybe(T)` serializes.** `anyOf: [T, null]` would hide an artifact marker from the walker,
which is now a compose error (D2). So `Maybe(File)`, an optional artifact (CORE-15), would never compose.
- A. Maybe-ness of a whole port comes from the graph: a guarded node's outputs are Maybe, and compose checks for
  `or` or a matching guard. Inside a record, `Maybe` is a property left out of `required`. No new keyword.
  *(recommended)*
- B. An annotation keyword, `x-maestro-maybe`, on T.
- C. `anyOf` with null, and the walker learns that one combinator shape.

## ADR 0008 (worker references): review says not lockable, so S2 is blocked

`docs/adr/0008-code-nodes-name-exported-functions.md` stays `proposed`. A fresh sonnet reviewer found three breaking
issues. The conductor checked each against the docs and agrees. Each needs a design call before the ADR can be
revised:

**[W1] Code outside a pack has nothing to resolve against.** D-29 lets `compose`/`perform` take a bare `.ts`/`.js`
composition. Hand-written IR (AC-8) and SDK unit tests have no pack either. And hashing one unbundled `.ts` file misses
its relative imports, which is the same stale-helper flaw the ADR rejects for `fn.toString()`.
- A. A bare composition file is its own entry: `module` is relative to the file's directory. `perform` bundles a
  bare `.ts` in memory first (`Bun.build`), so `codeHash` always covers a bundle. IR files resolve `module` against
  the IR file's directory. *(conductor's lean)*
- B. Bare files are not bundled, and a bare file's `codeHash` is a hash of the whole source tree under its directory.
- C. Drop bare-file `perform` from V1 (changes D-29): only packs and IR files run.

**[W2] Cross-pack subcompositions (SDK-05, sdk-spec 8).** Pack A using pack B's subcomposition builds code nodes whose
functions are B's exports. One entry namespace cannot name them, and the worker reference has no pack field.
- A. `module` is pack-qualified, `<pack id>:<entry path>`, and the build gets every loaded pack's namespace. The
  worker resolves the pack id through workspace config. No IR field change, but `module` gains a format. *(lean)*
- B. Add a `pack` field to the worker reference, which is an IR 1.1 change.
- C. Cross-pack use only reuses graph shape; a pack re-exports any foreign function it runs. This is fragile.

**[W3] `until` and `key`.** `until` lowers to a body port holding a boolean (IR README). The sdk-spec 14 examples
write `until: (c) => c.ok`, a build callback returning a Ref, which is fine. They also write
`(c) => c.outcome !== "rejected"`, a JS comparison on a Ref, which SDK-03 already forbids regardless of ADR 0008. The
golden fixture lowers its `until` to an exported code node.
- A. The ADR states that `until` is a build callback returning a `Ref<Bool>`, and that a predicate needing code is an
  exported code node. Fix the sdk-spec 14 example to a Ref expression. A `map` key function is an exported function
  like `code`. *(lean; an amendment, not a redesign)*

**AMEND items to fold into the revision** (no call needed unless you disagree):
- Stdlib `codeHash` is an explicit exception to `sha256:`.
- The cache keys stdlib nodes on the version the engine *will* run.
- What happens when the engine lacks a named stdlib export: a compose error.
- Fixtures migrate `stdlib/reducers.ts` to `maestro:stdlib`.
- S5's "exactly the affected nodes" needs your explicit sign-off as "nodes whose code hash or inputs changed". With a
  bundle-wide hash, per-node invalidation is testable only on hand-written IR.
- The worker reply carrying the stdlib version is a protocol change (CORE-14), so the S4 brief takes it.
- A non-exported function needs its own diagnostic code, not `REF`.
- One function exported under two names is resolved deterministically (first name in sorted order) or made an error.
- Drop the wrong ADR 0002 citation.

## Raised by S1c (not blocking)

**[A1] `codeHash` form.** `ArtifactRef.contentHash` enforces `sha256:<64 lowercase hex>`. A worker's `codeHash` is
only a non-empty string in `ir.schema.json`, and the golden fixtures use placeholders (`sha256:0000`). Proposed
ADR 0008 adds a second form for stdlib nodes (`maestro:stdlib@<version>`).
- A. Settle the form in the ADR 0008 revision, then tighten the IR schema and fixtures in one change. Tightening the
  schema is a breaking change under the IR policy, so it happens before any emitter ships. *(recommended)*
- B. Leave `codeHash` free-form; only the executor and cache interpret it.

**[A2] `producer.expansion` format.** It is any string for now. S4 fixes the node-instance identity (architecture 7,
`lens[3]/skeptic`). Recorded so the S4 brief tightens the schema once that format exists.

## Overnight status

Commits, not pushed:

| Change         | Subject                                                     |
| -------------- | ----------------------------------------------------------- |
| `wowryznkvwkv` | `feat(ir): outcomes, Settled and the x-maestro-type keyword` |
| `mlwyprmozvzn` | `feat(ir): artifact reference shape`                        |
| `zulppwvmytkz` | `docs: wave 3 briefs, proposed ADR 0008, open calls`        |

S1c passed review with 7 findings, 4 of them accepted, and one fix round. `just check`: 197 pass, 0 fail. The loop
table is in `docs/reports/s1c/slice-report.md`.

Blocked and stopped:

- S2 (`.scratch/s2-sdk-build/spec.md`) waits on W1 to W3, which ADR 0008 needs before it locks, and on S2-Q1 to S2-Q4.
  ADR 0008 stays `proposed`: the fresh review found breaking issues, so per your condition it was not locked.
- S34 (`.scratch/s34-core-seams/spec.md`), and so S3 and S4, waits on C1 to C3.
- Nothing else can be dispatched without one of these calls.

Classifier blocks: none.
