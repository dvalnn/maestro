# maestro: architecture and system view

Status: draft 2, 2026-10-14. Read `requirements.md` first for goals, glossary and decisions (D-xx, CORE-xx and so on are
defined there). This document is a system-level view. It fixes responsibilities, boundaries and flows, and leaves module
internals to the implementation.

## 1. Overview

maestro executes **compositions**. A composition is TypeScript code that, when built, yields a **graph**: typed nodes
joined by typed edges, serialized as a language-neutral **IR**. The **core** validates, bounds, schedules, records and
resumes graphs and knows nothing about what the nodes do. A **host** teaches the core new node kinds. The coding-agent
host adds nodes that run coding agents in isolated working copies. **Packs** carry compositions, prompts and code nodes
for a domain.

```
 author time                         compose stage                         perform stage
 -----------                         -------------                         -------------
 composition.ts  --build-->  IR  --validate/expand/bound-->  plan  --perform-->  record + events
      ^                      ^                 ^                                |
      |                      |                 |                                v
   SDK (+ host SDKs)   other-language     host.validate/bounds            workers (code nodes)
                       emitters (later)                                   host runtime (agent nodes)
```

Three properties drive the design:

1. **Symbolic build.** Building never sees a value. Because the graph is data before anything runs, everything that can
   be checked, bounded or drawn is checked, bounded or drawn first.
2. **Domain-free core.** The core's vocabulary is graph, node, edge, outcome, artifact, concert. The word "agent" does
   not occur in it.
3. **Code where code is honest.** The graph holds structure. Data plumbing, parsing, merging and policy that need real
   code are first-class **code nodes** with typed ports, not hidden in the orchestration.

## 2. System context

Actors and external systems:

- The **operator** (a person or a conductor agent) drives the CLI.
- **Harnesses** (coding-agent runtimes such as pi and Claude Code) are driven by the coding-agent host through adapters.
- **Model providers** are reached only through harnesses.
- A **target repository** is read by the host to cut lanes. It is never written by a concert (HOST-03).
- The **filesystem** holds config, the record store, lanes and artifacts.
- **Renderers** consume the IR and the event stream.

```
 operator --CLI--> maestro CLI --> core engine --+--> workers (code nodes)
                                      |          +--> host: agent / check nodes --> harness adapters --> agents
                                      |                         |                              |
                                      v                         v                              v
                                record store + events     lanes (worktrees), sandbox     model providers
                                      |
                                      v
                                  renderers
```

## 3. Layers and packages

A monorepo of separately versioned packages (DIST-03). Package names are workspace names that are never published
(D-31).

| Layer            | Package           | Responsibility                                                                                                         | Knows about                |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| IR               | `ir`              | The IR schema, its version and validators. No runtime.                                                                 | nothing                    |
| Core             | `core`            | Graph model, compose checks, executor, resume, record store, events, config layering, worker protocol, host interface. | `ir`                       |
| SDK              | `sdk`             | Authoring API: compositions, node constructors, Refs, types, subcompositions, stdlib. Emits IR.                        | `ir`                       |
| Test kit         | `testkit`         | Fake host, build and compose-time assertions, stub concert.                                                            | `core`, `sdk`              |
| CLI              | `cli`             | Commands, derived input flags, output formats, exit codes, host and pack loading.                                      | `core`, `sdk`              |
| Agent host       | `host-agents`     | Agent and check node kinds, lanes, sandbox, harness adapter interface, host config namespaces.                         | `core`                     |
| Agent host SDK   | `host-agents-sdk` | Typed constructors for agent and check nodes, lane types, report types.                                                | `sdk`, `host-agents` types |
| Harness adapters | `harness-<name>`  | One adapter per coding-agent runtime.                                                                                  | `host-agents`              |
| Packs            | `pack-<domain>`   | Compositions, prompts, schemas, code nodes, params.                                                                    | `sdk`, `host-agents-sdk`   |
| Renderers        | `render-<form>`   | Static graph render, live view.                                                                                        | `ir`, event stream         |

Dependency rule: arrows only point down the table. `core` and `ir` never import a host, a pack or an adapter. CORE-12 is
enforced by a test and by an import-graph check.

## 4. Lifecycle of a concert

The lifecycle has two stages (D-12). **Compose** is steps 1 to 4, ending with pre-flight, and spends nothing.
**Perform** is steps 5 to 7 and starts a concert.

- `compose <composition>` stops after step 4. By default it is an explicit validation step reporting diagnostics. It can
  save the IR to a file (D-13). With no params it uses the first example input set (D-19).
- `perform <composition>` runs compose first and continues only if pre-flight produced no error diagnostic.
- `perform <IR file>` skips the build (step 3), loads the IR, and still runs pre-flight before any node instance starts
  (NFR-02).

1. **Resolve.** The CLI loads layered config, every host the binary embeds (config has no `hosts` key), and the pack
   that owns the composition.
2. **Params.** A composition's declared params become CLI flags and are validated before build (D-17). They are plain
   values at build time. Node outputs and file contents are Refs, and a Ref never feeds a param (D-16).
3. **Build.** The composition's build function runs once with symbolic Refs and produces the graph. It is deterministic
   and side-effect free (CORE-06). Ambient state (environment, clock, randomness) is frozen (SDK-11). Compose can build
   twice and compare IR hashes (SDK-12).
4. **Pre-flight.**
   1. Serialize to IR and validate against the IR schema.
   2. Type-check every edge (CORE-02) and every prompt template variable.
   3. Resolve config: each namespace goes to its owner's schema (CFG-02, CFG-05).
   4. Expand bounded groups whose cardinality is known from plain values. A group whose size depends on a node result
      stays as a bounded region. Compose runs no author code (ADR 0009).
   5. Run host `validate(graph)` hooks (for example the lane double-join rule, a role and model policy).
   6. Compute bounds with host `bounds(node)`: maximum node instances and the hosts' named counts (such as agent runs)
      (D-23). There is no cost bound in v1.
   7. Emit the **plan**: diagnostics, counts, bounds and a renderable graph. Diagnostics of severity error stop here
      (NFR-02).
5. **Perform.** The executor instantiates node instances, schedules them by dependency, applies outcomes and edge
   tolerance, dispatches code nodes to workers and host nodes to their host, and writes events.
6. **Record.** Events and results go to the record store as they happen. A final result is derived by the result rule
   (CORE-04).
7. **Observe and resume.** `ls`, `wait`, `watch` and renderers read the record and events. `perform --resume` re-enters
   a concert at node granularity (CORE-09).

## 5. The IR (contract)

The IR is the contract between authors and the engine (D-09). It is JSON, versioned, and self-describing enough that a
renderer needs nothing else.

Contents, at the level of what it must carry:

- **Header.** IR version, composition id and version, pack id, build metadata (SDK version, source hash).
- **Scopes.** Named subgraphs created by subcomposition use, with their ports, so renderers can collapse them.
- **Nodes.** For each node: stable id (a path whose prefixes are its scopes and groups), kind, source location, typed
  ports (schemas), guard, declared reads and writes (code nodes), kind-specific configuration (host kinds), and for code
  nodes a worker reference `{runtime, module, export, code hash}`.
- **Groups.** For `map`, `seq`, `repeat`: the body subgraph (a template), the cardinality (`exact` or `up to N`), the
  source of its items or iteration state, the stop condition reference, and the member-result port that feeds `collect`
  edges.
- **Edges.** From port to port, with kind `data`, `collect` or `control`, and for `control` the tolerance (`ok` only, or
  `ok` and `rejected`).
- **Result.** The node the composition returns, from which the result rule derives the concert result.
- **Provenance.** Optional compose-time additions: expansion and bounds. A plan is an IR plus these.

Properties:

- **Fan-in is explicit** (D-08): a `collect` edge from a group's member-result port into a downstream node, or a reducer
  node marked `fanin`. A node with several distinct upstreams is a barrier and shows as a multi-edge join.
- **Lanes are not fan-in.** A host node takes exactly one lane. Results from several lanes reach the next node as
  values.
- **Stable ids.** Node ids are derived from scope path and label so that renders, events and resume stay stable across
  builds of the same composition.
- **Byte-stable.** Same params, composed config and code give the same IR (CORE-06).
- **Language-neutral.** Nothing in the IR assumes TypeScript. A worker reference names a runtime, and v1 implements
  `ts`.

## 6. Host interface

A host is a package that the core loads. It is the only way node kinds beyond the core's set exist. A host supplies:

1. **Node kinds.** For each kind: name, configuration schema, input and output port schemas (possibly generic over the
   node's configuration), and `execute(instance, inputs, context)` returning outputs and an outcome. Compose checks a
   node's configuration and its ports in the IR against its kind, and perform checks the outputs against the ports. Core
   never says run or build (CORE-12): the SDK builds, core composes and executes. A kind can declare its outputs include
   artifacts.
2. **Types.** Named types the host's ports use (for example a lane handle), with a way to serialize them into the IR.
   Compose rejects a type name that neither core nor an installed host owns.
3. **`validate(graph)`.** A compose-time hook returning diagnostics. It sees the whole graph and its own kinds' nodes.
   This is where host rules live (the lane join rule, role and model policy, bind validity).
4. **`bounds(node)`.** Bounds for a node instance as named counts, like metrics (CORE-19): core sums each name and
   config caps it by name, for the plan's size bound (D-23). The agent host counts agent runs under its own name.
5. **Environment.** Host facts visible to code nodes through a typed context (for example the current target). The
   core's own context holds only the concert id, a clock value and the instance's scratch directory (ADR 0007).
6. **Config namespaces.** Schemas for the namespaces the host owns.
7. **Event enrichment.** Extra fields added to events and the record for its node kinds, when an instance settles, and
   progress events emitted while it executes, such as an agent's tool calls and thinking (CORE-10). The core stores them
   opaquely.
8. **Cancellation.** A way to cancel a running node instance and release resources (kill the process tree).
9. **Optional seams.** `param(type, text)` reads a param of one of its types from the text a flag or YAML gave it.
   `release(concert)` frees what it holds for a settled concert, and `usage(concert)` reports its bytes on disk, for
   `prune` and `ls`.

The core never inspects a host's types or rules beyond checking that each type name has an owner. It only calls these
hooks and records what they return.

## 7. Execution model

- **Node instances.** A node instance is a node id plus an expansion path: one `[key]` per enclosing group, outermost
  first, where a `map` contributes its item key and `repeat` and `seq` their iteration index (`[risk]`, `[risk][2]`, or
  empty outside groups). It is shown merged into the id, as `lens[risk]/skeptic`. Events and records use this identity.
- **Scheduling.** A node instance is ready when all `data` and `collect` inputs are settled and its `control` edges
  allow it. The executor runs ready instances up to the concurrency cap.
- **Outcomes.** `ok`, `rejected`, `failed`, `skipped`.
  - A dependent over an `ok` edge runs only after `ok`. A dependent over a tolerant edge also runs after `rejected` and
    receives the reason.
  - `failed` and `skipped` are not tolerable. The dependent is `skipped` and its own dependents follow the same rule.
  - A `map` declares `onError`. With `settle`, a non-ok member becomes a `Settled` value and the group is `ok`. With
    `propagate`, the worst member outcome becomes the group's and running members are cancelled (ADR 0006). `seq` and
    `repeat` end on their stop condition or bound.
- **Groups.**
  - `map` instantiates its body once per item, in parallel up to the cap. An item with a primitive value is keyed by
    value and any other item by index, or by an author-supplied key function. Duplicate primitive or index keys of a
    list known at build are a compose error. Duplicates a key function gives fail the `map` at perform, since the
    function runs only there (D-18, SDK-13). Keys give readable node instance ids for `ls` and lane refs.
  - `seq` instantiates the body per item in order and stops at the first item meeting the condition. This covers
    escalation over models.
  - `repeat` carries typed state: an initial value, a step producing the next state, a stop condition and a maximum.
    This covers fix-until-green and review-revise loops.
- **Guards.** A `when` guard that is false makes the node `skipped`. Compose resolves guards that depend only on known
  values.
- **Result.** The result rule starts at the returned node. An `ok` node is the result. Otherwise it follows the node's
  non-`ok` inputs, and a group's result member, that the graph does not tolerate (a tolerated rejection or a `Settled`
  input), the first to settle when several did, to a node with no such input: the root cause, with its outcome and
  reason. A node skipped by its own false guard is the result, and counts as rejected.
- **Resume.** Re-entering a concert keeps its id and runs its stored IR. A recorded `ok` instance is reused when its key
  still matches: a hash of the node definition, its code hash recomputed from the current code, and its input values
  with artifact content hashes. Any other instance runs again, so a fix to one node's code reruns that node and those of
  its dependents whose inputs changed. A concert whose process is still alive cannot be resumed. Nothing is reused
  across concerts.
- **Cancellation and timeouts.** Cancelling a concert cancels running instances through their kinds' cancel hook, in
  reverse dependency order, and settles them as `failed` with a cancellation reason. An instance that never started has
  no record. A code node that runs past the timeout its author set settles `failed`. It has none by default.

## 8. Configuration

Params and config resolve, highest precedence first (CFG-04, D-17): the use site for a subcomposition or the CLI flag
for a root composition, then profile, workspace and user YAML, then the declared default. A composition's YAML keys live
under its pack id and then its composition id. Hosts keep pure-config namespaces. Files are YAML. The core:

- parses and layers them,
- validates the closed **core config** schema (CFG-01),
- hands each other top-level namespace to the registrant that owns it for validation at compose time (CFG-02),
- reports each value's source layer in the composed config view (CFG-06).

Who owns what:

- **Core.** Concurrency, caps by name, the data root and the workspace's name.
- **Host.** `target`, `roles` and other host namespaces (HOST-12).
- **Composition.** One param declaration in code covers CLI inputs and tunables, with defaults. For example a
  repair-loop subcomposition owns its maximum iteration count. The core has no limits concept.
- **Pack.** Its id, holding its compositions' params, and no other namespace.

Unclaimed keys (D-24): a key that no installed registrant claims is a compose error with a did-you-mean hint. A key
claimed by an installed but unused registrant is ignored.

## 9. Workers and code nodes

- A **code node** is the author's function, with typed inputs, typed outputs, and declared reads and writes. It runs at
  perform, in a **worker** of its declared runtime.
- v1 provides an **in-process TypeScript worker**. The **worker protocol** is specified so other runtimes and
  out-of-process workers can follow: a node invocation carries node id, expansion path, input values and their port
  schemas (`in`), artifact references and context. The reply carries outputs and an outcome (`ok`, or `rejected` with a
  reason and optional outputs), or an error. Workers support cancellation and timeouts. The in-process worker cannot
  stop a running function: a cancelled or timed-out invocation settles at once and its function is abandoned. A
  synchronous function that never returns blocks the process. Long work belongs in a host.
- **No compose-time evaluation.** Compose runs no author code (ADR 0009). Every code node may read the clock and the
  concert id from its context.

## 10. Record and events

- The **record store** is local and embedded. SQLite in WAL mode through `bun:sqlite` is the store (D-26). Concerts may
  run concurrently with no coordination beyond lane isolation, and the concurrency cap is per concert. The schema is new
  (D-02). It holds concerts with their IR, the id of the process performing them, where their code came from (workspace,
  module directory, file), tour and title; node instances, outcomes with reasons, durations, metrics, artifact
  references and events. Config is not stored.
- A resume marks the concert's instance rows **stale**. Each one it reuses or replaces stops being stale, and the
  metrics of a replaced attempt still count towards the concert's.
- A concert whose process is gone while it is still `running` settles `failed`, by whichever reader finds it, so `wait`
  ends and resume can continue from it. Only `kill` checks that a live process is maestro, so a pid another program
  reused keeps the concert `running` until `kill` settles it.
- Until the first release, a record store of another schema version is refused, not migrated.
- **Metrics** (CORE-19, D-23) are named additive numbers per node instance. The engine sums each name per concert and
  attaches no meaning to a name. v1 reports token counts only.
- **Events** are append-only, keyed by node id and expansion path, with the instance's state, timestamps, outcome and
  host enrichment. They are the single source for `watch` and renderers (NFR-07).
- An instance's scratch directory is removed when it settles. What lasts is in artifacts, lanes and events.
- **Artifacts** are files on disk under the concert's area, referenced by content hash and provenance (which node
  instance produced them). Large values are artifacts, not inline.
- **Queries** needed by the CLI: list concerts with filters, find a concert by id, list node instances of a concert,
  wait for a terminal state, read the concert result, set a concert's tour, resume a concert and remove one.

## 11. Rendering

A renderer needs only the IR (or plan) and events:

- **Static.** Nodes by kind, scopes collapsible, `data` edges solid, `control` edges dashed, `collect` edges drawn as
  barriers with the fan-in reducer shown. Groups show their cardinality (`3`, `up to 14`) and, when compose expanded
  them, the expansion.
- **Live.** The same graph with node-instance state overlaid from events.

The first renderer targets text (ASCII or Mermaid) in the plan output. A richer viewer is out of scope.

## 12. The coding-agent host

This host carries the concepts that sssf entangled with its engine. The vocabulary is fixed in D-21 and `GLOSSARY.md`.

**Node kinds**

- **Agent node.** Inputs: a prompt (text, staged by the host, no argument-length limits), a role (harness, model,
  thinking level, prompt includes), a lane input, optional read-only binds, and typed output declarations (files the
  agent must write, with schemas). Outputs: the declared files as typed artifacts, a standard report, outcome and
  reason, metrics (token counts), and the resulting lane handle. `rejected` means the agent's own verdict is negative.
  `failed` means the run did not complete.
- **Check node** (D-22). Runs deterministic commands in a lane. `rejected` on a red result, logs as an artifact. It is
  its own host kind and not a code node, because it runs untrusted target commands and needs the sandbox, lane staging,
  kill and logs. Code nodes are trusted and run in process.

**Lanes**

- A lane is an isolated working copy cut from a target at a base. Every node's lane output is an immutable version.
- `fresh(base)` makes a new lane. `fork(v)` copies the state at version `v`. `join(v)` continues the lane from `v` and
  yields the next version. A version may be joined at most once and forked any number of times. The host's `validate`
  hook rejects a second join of one version and a node with more than one lane input.
- The concert's result is a **changeset** (a patch series) attached to the record. Applying or committing it is a
  separate, operator-owned step. The target's checkout, refs and commits are never written by the host (HOST-03).
- A **lane ref** param, written `<concert id>.<node instance id>`, lets a concert fork a version left by an earlier
  concert (D-27, HOST-13). There is no cross-concert join, and a warm harness session cannot continue across concerts.
  Lanes stay on disk until `prune`.

**Sandbox**

- The agent process is confined: writable only in its lane's directory, read-only for declared binds, no secrets in its
  environment beyond what the harness needs, and none written to logs. The backend is bubblewrap behind a pluggable
  interface, and the initial port targets Linux x64 only (D-25).
- Sandbox policy is host config. A node can add read-only binds and cannot widen write access.

**Harness adapters**

- An adapter starts an agent session for a role, feeds it the prompt, streams events (turns, tool calls, usage),
  collects the declared outputs, and supports cancel. It is a sandboxed subprocess driving the harness's JSON event
  stream (D-20). An in-process SDK is deferred, because an in-process agent cannot be confined by bubblewrap. The first
  adapter is pi (`pi -p --mode json`) and the second is Claude Code.
- Adapters report token usage to the host. The host reports it to the core as metrics on the node instance (D-23).

**Host validation rules (initial)**

- Lane rule (HOST-02).
- Role and model policy declared by a composition (for example a skeptic's model family must differ from its lens's).
  Compositions state such policy with `assert` nodes. The host supplies the helpers that compute a model's family.
- Read-only binds exist and are not inside a lane's writable area.

## 13. Packs

A pack is a directory or release tarball with a `maestro-pack.json` manifest and one pre-bundled entry file that
includes its own SDK copy (D-30). The workspace config lists packs by path, and nothing is resolved through
`node_modules`. Compose consumes only IR JSON, so a second SDK copy is harmless as long as nothing relies on
`instanceof` across copies. A pack contributes compositions, prompt templates, schemas, code nodes and params.
Everything domain-specific lives here: for example the Gerrit comment parser and renderer, a catalogue of review lenses,
a knowledge directory. Hard-coded environment facts (a repository path, a change number, a commit SHA) are inputs or
round-folder data, never constants in a pack.

## 14. Distribution

- Bun is the runtime baseline (D-03). Distribution is internal (D-31): the binary `maestro` and package tarballs are
  released from a private forge, nothing is published to a public registry, and the license is `UNLICENSED`.
- The executable is built with `bun build --compile`, embeds core, SDK, CLI and the agent host, and runs on Linux x64
  (glibc only), on modern Linux (D-34). Packs load as external bundles (section 13), which keeps the binary generic.
- Slice 0 checks five things (D-32): the compiled binary runs on modern Linux, `bun:sqlite` WAL works inside it, it
  loads an external pack bundle and calls its code node, Bun spawns bubblewrap plus pi and streams the JSON events, and
  a binary built on a modern host runs on RHEL 8 as a best-effort probe. The first four gate the port. The fifth does
  not gate, and releases build on a modern host (D-34).
- The IR carries a version so a newer core can still read older IR within the compatibility policy (CORE-16).

## 15. Key design decisions and alternatives

| Decision          | Chosen                                                | Alternatives considered                             | Why                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoring surface | Code SDK that builds a graph, symbolically            | YAML DSL with expressions; imperative scripts       | YAML needs an expression language the moment data plumbing appears, and creeps. Imperative scripts cannot be checked before spend. Code plus symbolic build gives typed plumbing and a checkable graph (D-04, D-05).                                             |
| Engine language   | TypeScript on Bun                                     | Rust engine with out-of-process chains; keep Python | Code nodes in TS make the engine and the author share a language and process, with strong generics for typed refs. The harness SDK ecosystem is TypeScript. A Rust binary would still need Node or Python for code nodes, losing its packaging advantage (D-03). |
| Graph shape       | Static skeleton plus bounded regions                  | Fully dynamic graphs built at perform time          | Compose needs bounds. Perform-time-shaped regions are allowed only with a declared maximum.                                                                                                                                                                      |
| Lanes             | Versioned handles checked by a host hook              | Program order implies correctness                   | Symbolic graphs have no program order. Versions put order in the data.                                                                                                                                                                                           |
| Core and agents   | Core is generic, agents are a host                    | Agents in the core                                  | Keeps the core testable alone, and lets other hosts exist (D-06).                                                                                                                                                                                                |
| Outcomes          | Four states with per-edge tolerance                   | Pass and fail only                                  | Rejection by a gate differs from infrastructure failure, and a red check is useful input to a repair (CORE-04).                                                                                                                                                  |
| Config            | Namespaced pass-through, composition-declared schemas | One global schema                                   | Core must not grow with every composition's needs (D-07).                                                                                                                                                                                                        |
| Adapters          | Sandboxed subprocess over each harness's JSON events  | In-process harness SDKs                             | An in-process agent cannot be confined by bubblewrap, and the subprocess contract is the same for every harness (D-20).                                                                                                                                          |
| Packs             | Pre-bundled directory or tarball, listed by path      | npm packages resolved through `node_modules`        | The compiled binary cannot resolve `node_modules`, and compose only consumes IR JSON, so a bundled SDK copy is harmless (D-30).                                                                                                                                  |
| Resume            | Content-hashed node instances                         | File-presence reuse; a result cache across concerts | Correct under code or input change. A cross-concert cache would hit only code nodes upstream of every agent node, since agent nodes are never reused. Concert fork replaces it (`rulings.md`).                                                                   |     |

## 16. Failure modes

- **Compose error.** No agent starts. The CLI prints diagnostics and exits with a usage-category code.
- **Node `failed`.** Dependents `skipped` unless a settling group or a fan-in node received it as `Settled`. The concert
  result follows the result rule.
- **Node `rejected`.** Follows edge tolerance. This is the normal path for a red check or a negative review.
- **Host crash or kill.** The record is consistent as of the last event. `resume` continues. Agent process trees are
  killed by the host's cancel hook.
- **Worker error.** A code node that throws settles as `failed` with the error. A timeout is `failed`.
- **Disk full.** Hosts with a small system partition are common. The record store, artifacts and lane stores live under
  a configurable data root, by default in the user's XDG data home.
- **Stale reuse.** Resume recomputes each code hash from the current code, so a changed node runs again, and so does
  each dependent whose inputs changed.

## 17. Open design points

No open question blocks the initial port. `requirements.md` section 9 maps every earlier question to the decision that
resolved it. Deferred: a secret param type (D-33), cost accounting and budgets, per-adapter compaction, a cross-concert
join, starting a concert from a finished one's results (`rulings.md` "Concert fork"), in-process SDK adapters, arm64 and
macOS, and licensing.
