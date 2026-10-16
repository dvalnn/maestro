# Calls for the owner, wave 3

Accumulated by the conductor overnight on 2026-10-15. Each call has a tag to answer by, the options, and the conductor's
recommendation. Nothing listed here has been decided or dispatched.

## Blocking the core-seams slice (S34), and so S3 and S4

**[C1] CORE-12's word list vs the host interface.** CORE-12's scan rejects `run` and `build` in core packages.
Architecture 6 names the host kind hook `run(instance, inputs, context)`, and D-23 bounds count "agent runs".

- A. Name the hook `execute`, and say "build" only outside core (the SDK builds, core composes). _(recommended)_
- B. Narrow CORE-12's scan to the domain words that matter (lane, seat, leg, review, quality) and keep `run`/`build`.

**[C2] Where the graph index lives.** `packages/ir/src/graph.ts` already builds a private index (nodes, parents,
ancestors, enclosing groups) for `checkGraph`. S3 and S4 need the same lookups.

- A. Extract it into a small exported index in `packages/ir`, which `checkGraph`, S3 and S4 all use. _(recommended: no
  duplicate, and ir already owns the structural rules)_
- B. Core builds its own in the core-seams slice. Architecture 3 gives core the "graph model", but it duplicates ir's.

**[C3] `bounds(node)` without the word "agent".** D-23 bounds node instances and agent runs. Core cannot name agents.

- A. `bounds` returns named counts, like metrics (CORE-19). Core sums each name, and core config caps them by name. The
  agent host returns `{ "agents.runs": n }`. _(recommended)_
- B. A fixed second field with a neutral name, such as `hostUnits`.

## Carved out of S2 (S2 runs without them)

**[S2-Q1] Derived metadata (SDK-06).** "Composition metadata derives from the graph", but the IR has no metadata field,
and the predecessor's examples (roles used, whether checks run) are host concepts.

- A. A function over IR in the SDK (kinds and host namespaces used), computed on demand, never stored. _(recommended)_
- B. An IR field, which is an IR 1.1 change.
- C. Drop it from the SDK; the CLI or the host derives what it shows.

**[S2-Q2] Config namespaces a pack or composition claims (CFG-03, architecture 8).** The IR has `config`, but sdk-spec
gives no SDK API to claim a namespace.

- A. Wait for S6 (config) to define the claim API; S2 emits `params` only. _(recommended)_
- B. Design it in S2 now.

**[S2-Q3] CLI hints on params (sdk-spec 9: flag name, description, repeatable, required, default).** Standard JSON
Schema covers description, default, required and repeatable (an array). A flag name other than the param's own needs a
custom keyword, registered like `x-maestro-type`.

- A. Standard keywords only; the flag is the param name. S6 adds a keyword if it needs one. _(recommended)_
- B. Define `x-maestro-flag` (and short aliases) now.

**[S2-Q4] How a declared `Maybe(T)` serializes.** `anyOf: [T, null]` would hide an artifact marker from the walker,
which is now a compose error (D2). So `Maybe(File)`, an optional artifact (CORE-15), would never compose.

- A. Maybe-ness of a whole port comes from the graph: a guarded node's outputs are Maybe, and compose checks for `or` or
  a matching guard. Inside a record, `Maybe` is a property left out of `required`. No new keyword. _(recommended)_
- B. An annotation keyword, `x-maestro-maybe`, on T.
- C. `anyOf` with null, and the walker learns that one combinator shape.

## ADR 0008 (worker references): review says not lockable, so S2 is blocked

`docs/adr/0008-code-nodes-name-exported-functions.md` stays `proposed`. A fresh sonnet reviewer found three breaking
issues. The conductor checked each against the docs and agrees. Each needs a design call before the ADR can be revised:

**[W1] Code outside a pack has nothing to resolve against.** D-29 lets `compose`/`perform` take a bare `.ts`/`.js`
composition. Hand-written IR (AC-8) and SDK unit tests have no pack either. And hashing one unbundled `.ts` file misses
its relative imports, which is the same stale-helper flaw the ADR rejects for `fn.toString()`.

- A. A bare composition file is its own entry: `module` is relative to the file's directory. `perform` bundles a bare
  `.ts` in memory first (`Bun.build`), so `codeHash` always covers a bundle. IR files resolve `module` against the IR
  file's directory. _(conductor's lean)_
- B. Bare files are not bundled, and a bare file's `codeHash` is a hash of the whole source tree under its directory.
- C. Drop bare-file `perform` from V1 (changes D-29): only packs and IR files run.

**[W2] Cross-pack subcompositions (SDK-05, sdk-spec 8).** Pack A using pack B's subcomposition builds code nodes whose
functions are B's exports. One entry namespace cannot name them, and the worker reference has no pack field.

- A. `module` is pack-qualified, `<pack id>:<entry path>`, and the build gets every loaded pack's namespace. The worker
  resolves the pack id through workspace config. No IR field change, but `module` gains a format. _(lean)_
- B. Add a `pack` field to the worker reference, which is an IR 1.1 change.
- C. Cross-pack use only reuses graph shape; a pack re-exports any foreign function it runs. This is fragile.

**[W3] `until` and `key`.** `until` lowers to a body port holding a boolean (IR README). The sdk-spec 14 examples write
`until: (c) => c.ok`, a build callback returning a Ref, which is fine. They also write
`(c) => c.outcome !== "rejected"`, a JS comparison on a Ref, which SDK-03 already forbids regardless of ADR 0008. The
golden fixture lowers its `until` to an exported code node.

- A. The ADR states that `until` is a build callback returning a `Ref<Bool>`, and that a predicate needing code is an
  exported code node. Fix the sdk-spec 14 example to a Ref expression. A `map` key function is an exported function like
  `code`. _(lean; an amendment, not a redesign)_

**AMEND items to fold into the revision** (no call needed unless you disagree):

- Stdlib `codeHash` is an explicit exception to `sha256:`.
- The cache keys stdlib nodes on the version the engine _will_ run.
- What happens when the engine lacks a named stdlib export: a compose error.
- Fixtures migrate `stdlib/reducers.ts` to `maestro:stdlib`.
- S5's "exactly the affected nodes" needs your explicit sign-off as "nodes whose code hash or inputs changed". With a
  bundle-wide hash, per-node invalidation is testable only on hand-written IR.
- The worker reply carrying the stdlib version is a protocol change (CORE-14), so the S4 brief takes it.
- A non-exported function needs its own diagnostic code, not `REF`.
- One function exported under two names is resolved deterministically (first name in sorted order) or made an error.
- Drop the wrong ADR 0002 citation.

## Raised by S1c (not blocking)

**[A1] `codeHash` form.** `ArtifactRef.contentHash` enforces `sha256:<64 lowercase hex>`. A worker's `codeHash` is only
a non-empty string in `ir.schema.json`, and the golden fixtures use placeholders (`sha256:0000`). Proposed ADR 0008 adds
a second form for stdlib nodes (`maestro:stdlib@<version>`).

- A. Settle the form in the ADR 0008 revision, then tighten the IR schema and fixtures in one change. Tightening the
  schema is a breaking change under the IR policy, so it happens before any emitter ships. _(recommended)_
- B. Leave `codeHash` free-form; only the executor and cache interpret it.

**[A2] `producer.expansion` format.** It is any string for now. S4 fixes the node-instance identity (architecture 7,
`lens[3]/skeptic`). Recorded so the S4 brief tightens the schema once that format exists.

## Overnight status

Commits, not pushed:

| Change         | Subject                                                      |
| -------------- | ------------------------------------------------------------ |
| `wowryznkvwkv` | `feat(ir): outcomes, Settled and the x-maestro-type keyword` |
| `mlwyprmozvzn` | `feat(ir): artifact reference shape`                         |
| `zulppwvmytkz` | `docs: wave 3 briefs, proposed ADR 0008, open calls`         |

S1c passed review with 7 findings, 4 of them accepted, and one fix round. `just check`: 197 pass, 0 fail. The loop table
is in `docs/reports/s1c/slice-report.md`.

Blocked and stopped:

- S2 (`.scratch/s2-sdk-build/spec.md`) waits on W1 to W3, which ADR 0008 needs before it locks, and on S2-Q1 to S2-Q4.
  ADR 0008 stays `proposed`: the fresh review found breaking issues, so per your condition it was not locked.
- S34 (`.scratch/s34-core-seams/spec.md`), and so S3 and S4, waits on C1 to C3.
- Nothing else can be dispatched without one of these calls.

Classifier blocks: none.

## Rulings from the S2 and S34 reviews (2026-10-16)

- K1: diagnostic `hint` required; node, scope and source optional (absent means the whole IR). One `Diagnostic` and
  `SourceLocation` type in ir, used by ir, the SDK and core; `fromIrDiagnostic` goes; `BuildError` carries a
  `Diagnostic`.
- K2: A. `execute` gets `emit(event)` for host progress events (tool calls, thinking), stored durably in the event
  stream by node id and expansion path, contents opaque to core. Settle-time enrichment stays. Docs: CORE-10 and the
  sssf disposition table gain a line; `thinking` becomes a harness event kind in S8d.
- K3: a node hands back a file it wrote as a plain absolute path string at an artifact output; an object there is an
  `ArtifactRef` passed on.
- K4: A. `reject(reason)` returns plain `{ outcome: "rejected", reason }`; the outputs type excludes `outcome` and
  `reason`.
- K5: A. Every code function is `(inputs, ctx) => outputs | Rejection`, a ports object in and out; `ref.map` goes, so
  the worker reference needs no call field. `Rejection` and `reject()` live in ir. The SDK types `code()` so `fn` is
  checked against `in` and `out` at compile time, and a function that can reject shows it in its inferred return. No
  Rust-style wrapper: the union already is the sum type. A `map` key function stays `(item) => key`.
- K6: a failed build-time `assert` is an `ASSERT` diagnostic; the SDK's `TYPE` cases stay `TYPE`.
- K7: a build function is `(params, ports)`.
- K8: `tolerate: "rejected"`, a single value.
- K9: A. `defaultResult` and the sdk-spec 11 "selection helpers" line go (YAGNI). The SDK emits `{ rule: "default" }`.
- K10: a reducer worker receives one `Settled[]`, the `results` list or `[in0, in1, …]` in order (ADR 0006). A reducer
  given a map's handle uses its `results`, so `firstOk(plans)` works.
- K11: two unlabelled nodes with one derived id are `SCOPE.duplicate`, with a hint to add a `label`; no numbering.
- K12: core gives each instance its own scratch directory, `ctx.scratch`, deleted once the outputs are moved into the
  artifact area. A configurable scratch root is backlog.
- K13: `NodeInstance` moves into core's `./worker`; the `./graph` subpath goes.
- K14: the code-function context types move to ir, next to `Rejection`, so the SDK types `ctx` from them.
- K16: A. No shared-types package. ir holds the IR plus what the SDK and core must both see, since the SDK imports
  nothing else; the code-function contract (`Rejection`, `reject`, the context types) sits in one ir module so it can
  move out in one step if it outgrows ir.
- K15: D. A lift's id is its source node plus what it does (`review_summary`, `x_a_b`, `x_or`, `zip_a_b`), never the
  variable name, which JavaScript cannot see and bundling renames. Every lift also takes `label` for the clashes left; a
  second identical lift's hint says to reuse the earlier Ref.

## Rulings for S3 and S4 (2026-10-16)

- K17: C. An expansion path is one `[key]` per enclosing group, outermost first; `repeat` and `seq` use the iteration
  index. Keys are sanitized to `[A-Za-z0-9_.-]` (keys only name instances, D-18), and keys that sanitize alike are
  duplicates. Authors give a key function for records and paths: that is the intended way to get short, stable keys.
- K18: A. S3 and S4 take `loadCode` as an argument and test with fixture functions. The real loader (`resolveCode`,
  `loadCode`, backlog 08) lands in S6, the first slice that loads compositions from disk.
- K19: A. A slice S2b, fenced to `packages/sdk`, writes the stdlib functions (`pick`, `or`, `when`, `lookup`, `zip`,
  `join`, `firstOk`, `okOnly`, `settle`) in parallel with S3 and S4.
- K20: C. Compose compares only the `x-maestro-type` name and the JSON `type` (an `integer` fits a `number`) wherever
  both schemas declare structure, ignoring enums, required fields, extra properties and annotations. Perform checks each
  node's inputs against its declared `in` schema before it starts, so a finer mismatch spends nothing on that node.
  Equality falsely rejects `Enum` into `Text` and `Int` into `Float`; widening rules are easy to get wrong.
- K21: B. One result rule: the IR's `result` is `{ node }`, the node the build returned, still IR 1.0 (no emitter has
  shipped). An `ok` node is the result; otherwise the result is the root cause, reached by following non-`ok` inputs the
  graph does not tolerate (architecture 7). A reducer stays the result, since its inputs are `Settled`. Read literally,
  "first non-ok node on the critical path" reported a recovered escalation as rejected.
- K22: C. A pure node's context throws when `concert` or `clock` is read, at compose and at perform alike, with a hint
  to mark the node `pure: false`. A cached or folded pure node would otherwise freeze the first value. A folded node
  gets compose's scratch area and the hosts' facts, and `path()` throws; a node with artifact outputs never folds.
  `concert` is the concert id and `clock` is epoch milliseconds fixed at instance start.
- K23: A. A root build that returns no node is `TYPE.result`: returning nothing is an empty or invalid graph. Builds
  return the node whose outcome is the concert result, or a reducer over several.
- K24: A. A mixed list whose index key equals a primitive's value is a duplicate key; the hint says to give the map a
  key function (K17).
- K25: A. An id is `<enclosing id>/<segment>` for anything inside a scope or group, and `parseIr` enforces it, so every
  reader of ids can rely on it and `formatInstance` needs no fallback.
- K26: A. The IR drops `parent`: a node's parent is its id minus the last segment, and every proper prefix of an id is a
  declared scope or group (`IR.graph`). Parent cycles become impossible. An investigation built 68 IRs (fixtures, SDK
  tests, 11 ported sssf workflows) and found no construct whose logical parent differs from its id prefix.
- K27: A. The IR drops `label`: a node's name is its id's last segment, which every SDK-built node already matched. The
  SDK's `label` option stays, naming the segment; `tag` stays for display.
- K28: B. A stdlib lift that finds nothing (`pick` on a missing path, `lookup` on a missing key, `zip` over lists of
  different lengths) settles `failed`: a gap in data is a defect, not a verdict (ADR 0006). `.or(default)` still catches
  it; the stdlib rejects only in `firstOk`.
- K29: A. `join` matches scalar keys (string, number, boolean) by strict equality; a `null` or missing key is unmatched;
  an object or array key fails the node.
- K30: A. No unguarded-`Maybe` check and no `Maybe(T)` type: a skipped node's dependents are skipped (CORE-04), and an
  optional value is a record field left out of `required`. Closes S2-Q4.

## Rulings from the S3 and S4 reviews, and for S5 (2026-10-16)

- K31: A. The plan reports no maximum concurrency: perform's cap bounds it, and no decision reads the number (D-23).
- K32: A. The record stores the IR as a JSON column on the concert, written at start, for resume and renderers.
- K33: A. No record migrations until the first release; another schema version is refused, naming the file.
- K34: A. The concert stores its process id; a reader that finds a `running` concert's process gone settles it `failed`,
  "process exited". Matches the legacy approach.
- K35: A. An instance that never started has no record row; a cancelled concert is `failed` with the reason.
- K36: A. A concert that fails before any node runs has a result with no node, `failed` with the reason (CORE-04).
- K37: keep. An empty `seq` settles `skipped`.
- K38: A. The record stores neither params nor config; params are in the IR; secrets never go in params (CFG-03).
- K39: A. A cancelled or timed-out code node settles `failed` at once and its in-process function is abandoned.
- K40: A. An instance's scratch directory is removed when it settles.
- K41: A. A code node's `timeout` is a per-node option set by its author, in the IR, none by default. Timeouts on every
  kind and tolerating a timeout are backlog 11.
- K42: C. Resume runs the stored IR and reuses a recorded `ok` instance of that concert when its key (node definition,
  current code hash, inputs) matches, pure or not. A changed node and its dependents run again.
- K43: A. Resume reuses only `ok` instances; `rejected`, `failed` and `skipped` ones run again.
- K44: A. A resume keeps the concert id; resuming a concert whose process is alive is refused.
- K45: A. The cache is a table in the record store, policy `on` or `off`. A hit whose artifact is gone or differs is a
  miss; `prune` drops the entries of the concerts it removes.
- K46: A. The cache key's config is a cacheable host node's own host namespace; a code node's key has no config.

## Rulings from the wave 3 review (2026-10-16)

- K51: B. Params live only in the SDK and the CLI: the build consumes them, and the IR is the snapshot it produces. Core
  drops its params argument and `checkParams`, the plan stops echoing params, and the IR drops its `params` block (still
  IR 1.0). The CLI refuses a param flag on an IR file. Composed config resolving at perform and code pinned by hash are
  intended boundaries of that snapshot; recording the profile is YAGNI.
- K80: A. No content-hash cache in V1. A cache across concerts hits only pure code nodes and a pure prefix that compose
  already folds, since agent nodes are not cached and every node downstream of one sees new inputs. Resume carries
  CORE-09 and AC-3. `Host.cacheable` and core's cache config go; K45 and K46 are withdrawn and K52 is moot. Reusing a
  finished concert's results is a concert fork (K81, backlog 12).
- K48: A. On resume, the current code hashes replace the stored IR's in the record, so the stored IR names the code
  every `ok` instance ran under.
- K81: A. A concert fork selects by naming: a composition with ports may run at the root, each port fed from an earlier
  concert's recorded instance, written `<concert id>.<node instance id>` like a lane ref (HOST-13). Values are copied,
  artifacts imported by content hash, lanes fork-only, and the port's schema is checked against the recorded outputs
  before any spend. A map instance feeds its `results`. Matching a re-declared prefix by key is rejected: its misses are
  silent and spend. Timing waits for S8, backlog 12.
- K47: resume finds a recorded instance by node id and expansion path, then compares its key, so identical instances in
  a fan-out never share one result. The key holds no config: a changed profile does not rerun `ok` instances. Keys only
  compare inside one concert (K81), so no portability rule is needed.
- K50: B. `reject(reason, outputs?)`, the outputs nested in the rejection and, when given, complete and checked against
  `out` like an `ok` node's, so code and host verdicts carry findings alike. A tolerant consumer that reads a declared
  output of a rejection that carried none, code or host, fails with a reason naming the upstream. Amends ADR 0008 and
  pins ADR 0006's value on `rejected`.
- K49: A, refined. Compose checks each host node's `config` against its kind's schema, the IR's `in` and `out` against
  `kind.ports(node)` (the same port names, compatible by K20's rule) and that every `x-maestro-type` name is core's or
  an installed host's. Perform checks host outputs against `out` as it does code outputs, on `ok` and on a rejection
  that carries outputs (K50). `kind.outcomes` goes: nothing reads it.
- K79: A. Folding races a code node against its `timeout` through a helper shared with perform; a fold past it is a
  compose error naming the node and its timeout, and the function is abandoned. No `timeout` means no limit, as at
  perform. A synchronous function that never returns blocks the process at compose and at perform alike.

## Rulings on S6 (2026-10-16)

- K53: A. User config `$XDG_CONFIG_HOME/maestro/config.yaml`; workspace `.maestro/config.yaml` in the nearest ancestor
  of the cwd holding `.maestro/`; profile `.maestro/profiles/<name>.yaml`, chosen by `--profile`.
- K54: A. Maps merge by key; any other value, lists included, is replaced whole. Legacy merge tags are K87.
- K56: A. One data root key, default `.maestro/` in the workspace, closing backlog 09. No low-disk warning key.
- K62: A. Packs by path only in V1; a URL needs an install step (DIST-04).
- K65: B. One function reachable under two names is a build error naming both.
- K66: A. A pack's whole-bundle `codeHash` meets CORE-09, read as "nodes whose `codeHash` or inputs changed".
- K75: A. `config` prints values as they are. Secret handling is deferred (backlog 13).
- K58: A. No pack namespaces beyond its compositions' params in V1: nothing would read one. The IR's top-level `config`
  block goes with it (still IR 1.0), and architecture 8's Pack bullet with it.
- K87: A. The `yaml` package parses config, a new dependency allowed for it: `!replace`, `!append` and `!delete` with
  sssf's semantics, any other tag refused, and errors and provenance naming the file and line.
- K86: A, derived from K66. A dependent of a changed node reruns only when its inputs changed.
- K78: A. Exit codes 0 accepted, 1 failed and internal errors, 2 usage including compose diagnostics, 3 rejected, 124
  wait timeout.

## Open for the owner (2026-10-17 morning)

- S6 (brief `.scratch/s6-config-cli/spec.md`, Open Qs): forks K55, K61, K68, K69, K77; contracts K57, K59, K60, K63,
  K67, K71, K73, K76; derived K64, K70, K72, K74.
