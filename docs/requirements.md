# maestro: system requirements

Status: draft 3, 2026-10-14. Companion docs: `GLOSSARY.md`, `architecture.md`, `sdk-spec.md`, `port-plan.md`.

This document is self-contained. It assumes no access to the conversation, machine or workspace that produced it.
Anything not decided is listed in section 9 and is not guessed.

## 1. Purpose and context

maestro is the v2, spiritual successor of sssf (the "Super Simple Software Factory", version 1.0.0b6 at the time of
writing). sssf runs multi-agent coding workflows: it launches coding-agent sessions in isolated git worktrees, chains
stages (scout, plan, build, quality checks, review) into workflows called chains, records every run, and delivers the
result as a patch series. Its chains are Python modules that mix orchestration, data plumbing, prompts and policy.

What that costs, as observed in the predecessor's workflows:

- A workflow's shape cannot be checked before money is spent. Errors such as a skeptic model of the same family as its
  lens surface only when the chain's code reaches them.
- The same shape (lenses, a skeptic per lens, a consolidator) is copied between chains. The leg-running helper is
  duplicated verbatim.
- Data plumbing is hand-rolled in every chain: sidecar JSON parsed and `isinstance`-checked, files copied between run
  directories, a shell-sourced `vars` file, regex templating, reuse of earlier outputs by file presence, and degraded
  runs reported on stderr.
- Orchestration concepts have accreted: stages, chains in three tiers, performances, runs and legs, and a set of
  join/from/base/group/tag flags.

maestro replaces this with symbolic node-graph execution. A composition is code that builds a graph. The graph is data,
checked and bounded before any spend, and carried out by a core that knows nothing about coding agents. Everything about
coding agents lives in a host plugin. Everything about a specific domain (Gerrit, a verification suite) lives in packs.

maestro works in two lifecycle stages. **Compose** turns config and composition code into a checked plan and ends with
pre-flight, the full validation. **Perform** starts a concert, one carrying out of a plan. Nothing is spent before
compose succeeds.

## 2. Decision log

Decisions ruled by the project owner during design. Anything not listed here is proposed or open (section 9).

| ID   | Decision                                                                                                                                                                                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | The system is named **maestro**, the v2 spiritual successor of sssf.                                                                                                                                                                                                                                                                                                                                                 | A fresh identity for a clean break.                                                                                                                                                                           |
| D-02 | Clean break from sssf: no compatibility with its on-disk formats, config files, CLI contract or concepts. A fresh glossary. Legacy over-engineered concepts are dropped in favor of symbolic node-graph execution.                                                                                                                                                                                                   | The accreted concepts are unnecessary once the graph is data.                                                                                                                                                 |
| D-03 | TypeScript on Bun. Distributable, and tied to no particular workspace, machine or checkout.                                                                                                                                                                                                                                                                                                                          | Code nodes written in the authoring language tip the balance to TypeScript. A Rust core would still need a TypeScript runtime for them.                                                                       |
| D-04 | Compositions are written as code in a lean SDK that builds a graph. They are not YAML. YAML is used for configuration only.                                                                                                                                                                                                                                                                                          | The leanest API that can express the DAG lets the whole workflow be checked before spend, while code handles domain-specific plumbing.                                                                        |
| D-05 | Code stages are a first-class node type, and I/O between nodes is typed.                                                                                                                                                                                                                                                                                                                                             | Hand-rolled data plumbing was the largest source of per-chain code.                                                                                                                                           |
| D-06 | The core is domain-free. Core tests run real graphs with only code nodes and a fake host node kind, and the core never mentions lane, seat, leg, run, review or build.                                                                                                                                                                                                                                               | Keeps the core extendable to other domains.                                                                                                                                                                   |
| D-07 | Core config is decoupled from composition config. A composition declares its own typed config. The core checks YAML syntax and otherwise passes values through to the owner's validation at compose time.                                                                                                                                                                                                            | The core should not need to know any composition's settings.                                                                                                                                                  |
| D-08 | Fan-in is first-class in the IR so a renderer can draw a composition's graph before it is performed.                                                                                                                                                                                                                                                                                                                 | Upfront visualization needs fan-in to be explicit.                                                                                                                                                            |
| D-09 | The IR is language-neutral and versioned. Other languages may emit it later.                                                                                                                                                                                                                                                                                                                                         | Future authoring languages can feed the same core.                                                                                                                                                            |
| D-10 | The initial port is: core, SDK, and a coding-agent host vertical slice. The CLI is limited to `compose`, `perform`, `ls`, `wait`, `kill`, `config` and `prune`, with graph rendering part of `compose`.                                                                                                                                                                                                              | The smallest slice that proves the design end to end.                                                                                                                                                         |
| D-11 | Implementation happens where a checkout of the predecessor may be available. It is a behavioral reference, never a format or structure contract.                                                                                                                                                                                                                                                                     | Behavior questions get an authoritative answer without binding the new design.                                                                                                                                |
| D-12 | The lifecycle has two stages. **Compose** parses config and composition code, produces the IR, and ends with **pre-flight**, the full validation. **Perform** starts a **concert**, one run of a plan. These replace "launch" and "execution" as stage and run terms.                                                                                                                                                | Two stages with a hard boundary at which spend begins.                                                                                                                                                        |
| D-13 | The CLI verbs are `maestro compose` and `maestro perform`. `compose` is by default an explicit validation step (the full pre-flight) and can optionally save the IR to a file. `perform` starts a concert. Given a composition file it runs it through compose first.                                                                                                                                                | The command names mirror the lifecycle stages, and validation stays usable on its own.                                                                                                                        |
| D-14 | Every CLI verb has a built-in short alias, except `prune`, which has none.                                                                                                                                                                                                                                                                                                                                           | Long expressive verbs stay readable in scripts, short forms stay quick to type.                                                                                                                               |
| D-15 | A run is a **concert**. "Performance" keeps its plain meaning, execution speed.                                                                                                                                                                                                                                                                                                                                      | Leaves "performance" for speed, which is how engineers read it, and completes the theme.                                                                                                                      |
| D-16 | Build-time values: composition params and composed config are plain values during build, so build code may loop, branch and compute bounds on them. Node outputs and file contents are Refs. A subcomposition takes plain params and Ref ports. A plain value may feed a port, and a Ref never feeds a param.                                                                                                        | The graph stays a deterministic function of params and composed config, and everything else stays checkable before spend.                                                                                     |
| D-17 | A composition declares one set of typed params, covering CLI inputs and tunables alike. A param's value comes from, highest first: the use site (subcomposition) or the CLI flag (root), then profile, workspace and user YAML, then the default. YAML keys live under the pack id and the composition id. Hosts and packs keep pure-config namespaces.                                                              | One declaration instead of separate inputs and config. Keeps D-07, since a composition still declares its own typed settings in code.                                                                         |
| D-18 | `map` items with primitive values are keyed by that value. Other items are keyed by index unless the author gives a key function. Duplicate keys are a compose error.                                                                                                                                                                                                                                                | Readable, stable ids in events, `ls` and lane refs.                                                                                                                                                           |
| D-19 | Every composition declares at least one example input set. `compose` with no flags uses the first and flags override it. `perform` never uses examples.                                                                                                                                                                                                                                                              | `compose` can validate a bare composition file.                                                                                                                                                               |
| D-20 | Harness adapters drive coding agents as sandboxed subprocesses speaking each harness's JSON event stream. In-process SDK adapters are a later option for unsandboxed use. pi is the first adapter and Claude Code the second.                                                                                                                                                                                        | An in-process agent cannot be confined by the sandbox, because its tools would run inside the maestro process. See `adr/0001-sandboxed-subprocess-adapters.md`.                                               |
| D-21 | The coding-agent host vocabulary is final: agent node, role, lane (`fresh`, `fork`, `join`), target, changeset, harness, check node, sandbox.                                                                                                                                                                                                                                                                        | Settled by the project owner.                                                                                                                                                                                 |
| D-22 | A check node is its own host node kind.                                                                                                                                                                                                                                                                                                                                                                              | It runs untrusted target commands and needs the sandbox, lane staging, process-tree kill and logs. Code nodes are trusted and in-process and provide none of that.                                            |
| D-23 | The engine stores named additive numbers (metrics) per node instance and sums each name per concert. v1 reports token counts only. There is no cost, price table or budget in v1. Compose bounds are counts of node instances plus named counts a host reports, such as agent runs. A compaction mechanism per adapter may come later, outside the engine.                                                           | Cost is host policy that v1 does not need, and tokens are enough.                                                                                                                                             |
| D-24 | An unclaimed config key fails compose with a did-you-mean hint only when no installed registrant claims it. A key claimed by an installed registrant that the concert does not use is ignored.                                                                                                                                                                                                                       | Typos are caught, and a shared workspace config does not break compositions that use only some of its keys.                                                                                                   |
| D-25 | The initial port targets Linux x64 only. The sandbox backend sits behind an interface.                                                                                                                                                                                                                                                                                                                               | arm64 and macOS come later. Modern Linux is the baseline. See D-34.                                                                                                                                           |
| D-26 | Several concerts may run in one workspace with no coordination beyond lane isolation. The record store is one SQLite file in WAL mode and the concurrency cap is per concert.                                                                                                                                                                                                                                        | Keeps the first version simple.                                                                                                                                                                               |
| D-27 | Cross-concert lanes are fork only, through a lane ref param written `<concert id>.<node instance id>`. There is no cross-concert join. Lanes stay on disk until `prune` removes them.                                                                                                                                                                                                                                | Earlier concerts stay immutable and join-at-most-once never needs cross-concert tracking. A warm harness session cannot continue across concerts.                                                             |
| D-28 | Acceptance against the predecessor is semantic, on two toy tasks: T1 (fixable) and T2 (unfixable by construction). Compared: the sequence of agent and check runs by kind, the final outcome class, the files touched, and a clean target checkout. Not compared: patch text, tokens, wall time.                                                                                                                     | The clean break (D-02) removes byte-level comparison.                                                                                                                                                         |
| D-29 | CLI details. Aliases: `c` compose, `p` perform, `cfg` config, `w` wait, `k` kill, `wt` watch, `ls` unchanged, `prune` has no alias. `compose --out <file>` saves the IR. `compose` prints diagnostics and a one-line plan summary by default, with `--graph` and `--plan` for more. Resume is `perform --resume <concert id>`. `perform` tells a composition from IR by extension (`.ts` or `.js` versus `.json`).   | `prune` is typed in full by decision.                                                                                                                                                                         |
| D-30 | A pack is a directory or release tarball with a `maestro-pack.json` manifest and one pre-bundled entry file that includes its own SDK copy. Workspace config lists packs by path or URL. There is no `node_modules` resolution.                                                                                                                                                                                      | A compiled binary cannot share its embedded SDK with external files. Compose consumes only IR, so a second SDK copy is harmless if nothing relies on cross-copy `instanceof`. See `adr/0002-pack-bundles.md`. |
| D-31 | Distribution is internal. Package names are workspace names (`@maestro/*`, with `maestro-ai` as the fallback), releases (binary and tarballs) are served from a private forge, the license is `UNLICENSED`, and the binary is `maestro`. Nothing is published to a public registry.                                                                                                                                  | Licensing is decided later.                                                                                                                                                                                   |
| D-32 | Slice 0 proves five things: a compiled binary runs on modern Linux, `bun:sqlite` in WAL mode works inside it, the binary loads an external pack bundle and calls its code node, Bun spawns bubblewrap plus pi and streams the JSON events, and a binary built on a modern host runs on RHEL 8 as a best-effort probe. The first four gate the port. The fifth does not gate and does not pick the build host (D-34). | Cheapest way to retire the platform risks first.                                                                                                                                                              |
| D-33 | A secret param type is out of v1. Secrets are never params. A design where the host resolves secret handles at perform time is deferred.                                                                                                                                                                                                                                                                             | YAGNI.                                                                                                                                                                                                        |
| D-34 | Maestro targets modern Linux x64 and is built with current tooling on a modern host. The host floor is Bun's documented platform minimum, with no stricter floor. RHEL 8 class hosts are best-effort, and a failure there is a known limitation with a user workaround.                                                                                                                                              | RHEL 8 must not constrain tooling or the build host. See `adr/0003-modern-linux-baseline.md`.                                                                                                                 |

## 3. Goals and non-goals

Goals:

- **G1.** Pre-flight: a whole composition is validated and its size bounded (node instances and agent runs) before any
  model spend.
- **G2.** A lean authoring API that expresses multi-agent DAG workflows (fan-out, fan-in, bounded loops, escalation,
  conditionals) with code stages for the data plumbing that genuinely needs code.
- **G3.** A domain-free core. Hosts add node kinds, and packs add compositions.
- **G4.** A language-neutral, versioned IR as the contract between authors and the engine.
- **G5.** The graph can be rendered after compose and before any spend, and observed live during a concert.
- **G6.** Distributable on Bun, installable by others, ideally as a single executable.
- **G7.** Integration with coding-agent harnesses as sandboxed subprocesses over their JSON event streams. In-process
  SDK adapters are a later option for unsandboxed use (D-20).
- **G8.** Operable by agents: machine-readable CLI output, stable exit-code categories, actionable diagnostics.

Non-goals for the initial port:

- Compatibility with sssf state, config or CLI. No migration tooling.
- Porting every sssf command or chain. The slice is bounded by D-10 and `port-plan.md`.
- YAML compositions or an expression language. Code nodes cover what an expression language would.
- Spreading one concert across machines. One machine per concert.
- A hosted service, a web UI, or a replacement for the predecessor's viewer. The renderer contract is in scope. A GUI is
  not.
- Node.js compatibility. Bun is the baseline (D-03).
- Cost accounting, price tables and budget caps (D-23). Token counts are recorded.
- A secret param type (D-33).
- Joining a lane across concerts (D-27). Forking is supported.
- macOS and arm64 (D-25).
- Publishing to a public package registry (D-31).
- SDKs in languages other than TypeScript. The IR allows them (D-09), and none is built.

## 4. Actors

- **Operator.** A person, or a conductor agent session, who composes and performs through the CLI and observes the
  result.
- **Composition author.** Writes compositions and packs. Often an agent, so diagnostics must serve agents.
- **Host implementer.** Writes a plugin that gives the core new node kinds. The first host is the coding-agent host.
- **Core and SDK maintainers.**
- **Renderer author.** Consumes the IR and the event stream to draw graphs.

## 5. Glossary

The glossary is `GLOSSARY.md`, beside this document. It is the single source for terms and for the words to avoid.
Coding-agent host terms in it are final (D-21).

## 6. Functional requirements

Priority: **Must** is required for the initial port. **Should** is wanted and may slip. **May** is optional.

### 6.1 Core: graph and engine (CORE)

- **CORE-01 (Must).** The graph model has node kinds `code`, `map`, `seq`, `repeat`, `assert` and host kinds, with
  `when` guards and subcomposition scopes.
- **CORE-02 (Must).** Ports are typed with schemas that serialize to JSON Schema. Compose type-checks every edge.
- **CORE-03 (Must).** The IR distinguishes edge kinds `data`, `collect` and `control`. Fan-in is an explicit `collect`
  edge or a reducer node, never inferred.
- **CORE-04 (Must).** Outcomes are `ok`, `rejected`, `failed`, `skipped`. By default a dependent runs only after `ok`
  upstreams. An edge can tolerate `rejected`. The concert result is the node the composition returns when it is `ok`,
  else the root cause of its outcome. A concert that fails before any node runs has a result with no node, only `failed`
  and the reason.
- **CORE-05 (Must).** Every group declares its cardinality, `exact` or `up to N`, so compose can bound node instances.
- **CORE-06 (Must).** Building is symbolic, deterministic and side-effect free. It never reads a node's value. The same
  inputs and config yield byte-identical IR.
- **CORE-07 (Must).** The compose stage is: build, emit the IR, then pre-flight. Pre-flight performs schema and type
  checks, constant folding of pure code nodes whose inputs are all known at compose time (params and composed config),
  expansion of bounded groups, host validation hooks, bounds on node instances and agent runs, and diagnostics. Compose
  writes nothing outside a scratch area and spends nothing.
- **CORE-08 (Must).** The executor schedules node instances by dependency with a configurable concurrency cap, supports
  cancellation, and propagates outcomes per CORE-04.
- **CORE-09 (Must).** A failed or killed concert resumes at node granularity. A recorded `ok` node instance is reused
  while a content hash of its node definition, code version and inputs still matches.
- **CORE-10 (Must).** Every node-instance state transition emits an event with node id and expansion path. A host may
  emit progress events for an instance it is executing, such as an agent's tool calls and thinking, under the same keys.
  Events are durable.
- **CORE-11 (Must).** A record store holds concerts, node instances, outcomes, durations, metrics, artifacts and events,
  and supports the CLI queries in 6.6.
- **CORE-12 (Must).** Core has no domain words. A test enforces it: the core's own suite runs real graphs with only code
  nodes plus a fake host kind, and a scan rejects the words lane, seat, leg, run, review, build and quality in core
  packages.
- **CORE-13 (Must).** A host interface lets a host register node kinds, types, a `validate(graph)` hook, an
  `bounds(node)` hook and an environment, per `architecture.md` section 6.
- **CORE-14 (Must).** The worker protocol is defined for code nodes. The TypeScript runtime provides an in-process
  worker in the initial port. Out-of-process workers are specified and not required.
- **CORE-15 (Must).** Artifacts are first-class: typed file, directory and text, with provenance, optional values (a
  record field left out of `required`), and staging by whichever host node needs them.
- **CORE-16 (Must).** The IR carries a version and an explicit compatibility policy. A consumer rejects an unknown major
  version with a clear error.
- **CORE-17 (Should).** Diagnostics carry stable codes, the node id, the source location in the composition, and a
  suggested next step.
- **CORE-18 (Should).** Config is layered and validated per namespace per 6.2, and the composed config reports the layer
  each value came from.
- **CORE-19 (Must).** A node instance carries named additive numbers (metrics). The engine sums each name per concert
  and exposes the totals to hosts and the CLI. It attaches no meaning to a name (D-23).

### 6.2 Configuration (CFG)

- **CFG-01 (Must).** Core config is a small closed schema of engine concerns only: concurrency cap, record store
  location, event sinks, pre-flight strictness.
- **CFG-02 (Must).** Every other top-level config key belongs to a namespace owned by a registrant. The core checks YAML
  syntax, layers the files, and hands each namespace to its owner's schema at compose time.
- **CFG-03 (Must).** A composition declares typed params with defaults in code (D-17). The schema is exported in the IR.
  Subcompositions declare params and ports. Param values end up in the IR and the record, so secrets belong in config or
  the environment, never in params.
- **CFG-04 (Must).** Precedence, lowest to highest: param default, user-level YAML, workspace-level YAML, profile YAML,
  then the CLI flag (root composition) or the use site (subcomposition). YAML keys live under the pack id and the
  composition id (D-17).
- **CFG-05 (Should).** A config key that no installed registrant claims fails compose with a did-you-mean hint. A key
  claimed by an installed registrant that the concert does not use is ignored (D-24).
- **CFG-06 (Must).** The `config` command prints the composed config and validates it for a given composition.

### 6.3 SDK (SDK)

- **SDK-01 (Must).** A TypeScript SDK declares compositions: name, doc, typed params with CLI hints and defaults, and at
  least one example input set (D-19).
- **SDK-02 (Must).** Constructors exist for code, map, seq, repeat, assert, subcomposition use, and for host node kinds
  contributed by host SDKs.
- **SDK-03 (Must).** `Ref` semantics are enforced: build code cannot branch on a Ref. Lifting combinators (`pick`,
  `map`, `zip`, `join`, `when`) cover the common cases, and anything else is a code node. Params and composed config are
  plain values (D-16). The types distinguish Plain from Ref, and coercing a Ref to a boolean or string during build
  throws.
- **SDK-04 (Must).** Code nodes declare typed inputs and outputs, declared reads and writes, and a purity flag. Reads
  from ambient state mark a node impure.
- **SDK-05 (Must).** Subcompositions have typed signatures, plain params plus Ref ports (D-16), and are reusable across
  packs.
- **SDK-06 (Must).** Composition metadata that the predecessor declared by hand (required agents, whether checks run) is
  derived from the graph.
- **SDK-07 (Should).** A standard library supplies reducers (`firstOk`, `okOnly`), prompt templating with variables
  checked at compose time, and typed file readers.
- **SDK-08 (Must).** A test kit provides a fake host, build and compose assertions, and concerts with stubbed nodes.
- **SDK-09 (Should).** The SDK can emit IR to a file without performing it.
- **SDK-10 (May).** SDKs in other languages emit the same IR.
- **SDK-11 (Must).** Build runs with ambient state frozen: no environment, clock or randomness (CORE-06, D-16).
- **SDK-12 (Should).** Compose can build twice and compare IR hashes to catch nondeterministic build code.
- **SDK-13 (Must).** `map` items are identified by key: the value for primitive items, the index otherwise, or an
  author-supplied key function. Duplicate keys are a compose error (D-18).

### 6.4 IR emitters (IR)

- **IR-01 (Must).** The IR schema is published and independent of the TypeScript SDK. A hand-written IR file is
  performed with no SDK. This proves language neutrality (acceptance AC-8).

### 6.5 Coding-agent host (HOST)

- **HOST-01 (Must).** An agent node runs one role against a prompt in a lane of a target. It produces typed outputs
  (declared files), an outcome and reason, a report, metrics (token counts), and a lane handle.
- **HOST-02 (Must).** Lanes are versioned handles. `fresh(base)` cuts a new lane. `fork(handle)` copies the state at
  that version. `join(handle)` continues it. A version may be joined at most once, forked any number of times, and a
  node takes exactly one lane input. A host `validate` hook enforces this.
- **HOST-03 (Must).** A concert writes only its own lanes. The target's checkout, refs and commits are untouched.
  Results leave as a changeset.
- **HOST-04 (Must).** An agent runs sandboxed: writable only in its lane, read-only binds declared by the node or
  config, secrets never written to logs, events or records.
- **HOST-05 (Must).** A harness adapter interface exists. An adapter drives its harness as a sandboxed subprocess over
  the harness's JSON event stream (D-20). The slice implements pi. A Claude Code adapter is a Should.
- **HOST-06 (Must).** Prompts of any size reach the agent without hitting argument-length limits.
- **HOST-07 (Must).** Adapters report token counts as metrics per node instance, and the engine sums them per concert
  (CORE-19). There is no cost or price table in v1 (D-23).
- **HOST-08 (Deferred beyond v1).** A per-concert token cap enforced by the host's node runners. The id is kept so
  references stay valid.
- **HOST-09 (Must).** A check node (D-22) runs deterministic commands in a lane and returns pass or fail (`rejected`)
  with logs as artifacts.
- **HOST-10 (Must).** `kill` terminates agent process trees and the record stays consistent.
- **HOST-11 (Must).** The host's compose-time hook enforces lane rules, role-and-model policies declared by
  compositions, and read-only bind validity.
- **HOST-12 (Should).** The host owns the `target` and `roles` config namespaces.
- **HOST-13 (Must).** A lane ref param type names a lane version left by an earlier concert, written
  `<concert id>.<node instance id>`. Across concerts it can only be forked. Lanes stay on disk until `prune` removes
  them, and `ls` shows their disk use (D-27).

### 6.6 CLI (CLI)

The executable is `maestro`.

- **CLI-01 (Must).** `compose <composition>` takes a composition (a file, or a pack's composition by name) and its
  params, derived from the param schema, and runs the full compose stage including pre-flight. By default it is an
  explicit validation step: it reports diagnostics and exits with a category code, and starts no node instance.
  Optionally it saves the IR with `--out <file>`. With no params given it uses the first example input set (D-19). It
  prints diagnostics and a one-line plan summary by default, and `--graph` and `--plan` print more (D-29).
- **CLI-02 (Must).** `perform <composition | IR file>` starts a concert and prints the concert id on stdout. A
  composition is run through the compose subsystem first. An IR file is not built, and still goes through pre-flight
  (NFR-02). An error-severity diagnostic stops it before any node instance starts. `perform` can also re-enter an
  earlier concert to resume it (CORE-09). Resume is `perform --resume <concert id>`. `perform` tells a composition from
  an IR file by extension (`.ts` or `.js` versus `.json`). `perform` never uses example input sets. Performing an IR
  file with no SDK is AC-8.
- **CLI-03 (Must).** `ls`, `wait`, `kill`, `config` and `prune` exist. `prune` removes concerts and their lanes.
- **CLI-04 (Must).** Every command supports machine-readable output. Exit codes are stable and distinguish accepted,
  rejected, failed, usage error and wait timeout.
- **CLI-05 (Should).** `watch` draws the live graph.
- **CLI-06 (Must).** An error names what the operator or agent should do next.
- **CLI-07 (Must).** Every verb except `prune` has a built-in short alias, shown in help. Aliases are explicit and not
  inferred from unambiguous prefixes, so adding a verb never changes the meaning of an existing alias. Aliases are
  unique and stable across versions. The set is in D-29.

### 6.7 Packs and distribution (PACK, DIST)

- **PACK-01 (Must).** A pack is a directory or release tarball with a `maestro-pack.json` manifest and one pre-bundled
  entry file that includes its own SDK copy. Workspace config lists packs by path or URL, and nothing is resolved
  through `node_modules` (D-30). A pack contributes compositions, prompts, schemas, code nodes and params.
- **PACK-02 (Must).** A pack declares semver ranges on the SDK and host packages it uses.
- **PACK-03 (Must).** Domain concepts never leak into core or host packages. Packs may be domain-specific.
- **DIST-01 (Must).** The baseline runtime is Bun. The floor version is fixed during the first slice.
- **DIST-02 (Should).** A single executable via `bun build --compile`, verified in slice 0 on modern Linux (D-32, D-34).
- **DIST-03 (Must).** The repository is a monorepo of separately versioned packages with an independently versioned IR.
- **DIST-04 (Must).** No network use beyond harness and model traffic and explicit installs.
- **DIST-05 (Must).** Distribution is internal (D-31): release artifacts (the `maestro` binary and package tarballs)
  served from a private forge. Nothing is published to a public registry.

## 7. Non-functional requirements

- **NFR-01 Determinism.** Build and compose are deterministic. Execution order within a concert may vary inside the
  dependency partial order, and results must not depend on it.
- **NFR-02 No spend before validation.** A composition that fails compose starts no agent node.
- **NFR-03 Responsiveness (proposed targets, validate in the first slice).** Compose of a 200-node graph under 1 s. Cold
  start of `ls` under 150 ms.
- **NFR-04 Reliability.** A crash or kill leaves a record that resume can continue from. Code nodes time out and cancel.
- **NFR-05 Security.** Sandbox by default. Secrets are not logged. Packs run operator-trusted code, and this is
  documented.
- **NFR-06 Testability.** The core runs without a host. A host runs without real agents (stub harness).
- **NFR-07 Observability.** Every node instance is traceable from the CLI by id. The event stream is the single source
  for live views.
- **NFR-08 Portability.** Linux x64 is the baseline and the only initial platform (D-25). The host floor is Bun's own
  documented platform minimum (kernel 3.10 or newer, 5.6 or newer recommended). RHEL 8 class hosts are best-effort, a
  known limitation with a user workaround (D-34).
- **NFR-09 Leanness.** Each new node kind, edge kind or SDK primitive needs a written justification. The default answer
  is a code node or a stdlib helper.

## 8. Acceptance criteria for the initial port

- **AC-1.** The core test suite passes with no host and no domain words (CORE-12).
- **AC-2.** Composing the ported verification composition (the lens, skeptic, consolidator shape) reports the exact
  node-instance count, rejects a same-family skeptic before any spend, and rejects an unclaimed config key.
- **AC-3.** The ported build-then-repair composition shows its bounded unroll in the plan. With a stub host that rejects
  once then accepts, it performs to completion, and a killed concert resumes at node granularity without repeating an
  `ok` node.
- **AC-4.** With one real harness, the build-then-repair composition is performed on a toy target. It leaves a changeset
  and the target's checkout is untouched.
- **AC-5.** Compose renders both compositions as a graph showing fan-out, fan-in, loop bounds and conditionals.
- **AC-6.** `compose`, `perform`, `ls`, `wait`, `kill` and `config` work with JSON output, the documented exit codes and
  their short aliases.
- **AC-7.** The package installs and runs on a modern Linux host, as `bunx` or as a single binary.
- **AC-8.** A hand-written IR file is performed without the SDK.
- **AC-9.** Against the predecessor, tasks T1 (fixable) and T2 (unfixable by construction) match on the sequence of
  agent and check runs by kind, the final outcome class, the files touched, and a clean target checkout (D-28).

## 9. Open questions

None blocks the initial port. The questions raised during design were resolved in a review session. Ids are kept so
references in the companion docs stay valid.

| Question | Topic                                    | Resolved by                      |
| -------- | ---------------------------------------- | -------------------------------- |
| OQ-1     | Host vocabulary                          | D-21                             |
| OQ-2     | First harness adapter                    | D-20                             |
| OQ-3     | Config keying and use-site overrides     | D-17                             |
| OQ-4     | Unclaimed config keys                    | D-24                             |
| OQ-5     | Name of the pre-flight command           | D-12, D-13                       |
| OQ-6     | Pack discovery                           | D-30                             |
| OQ-7     | Single-binary feasibility                | D-32                             |
| OQ-8     | Platform matrix                          | D-25                             |
| OQ-9     | Check nodes                              | D-22                             |
| OQ-10    | Cost accumulator in the core or the host | D-23                             |
| OQ-11    | Use of the predecessor as a reference    | D-28                             |
| OQ-12    | Package naming and licensing             | D-31                             |
| OQ-13    | Concurrent concerts                      | D-26                             |
| OQ-14    | Cross-concert lanes                      | D-27                             |
| OQ-15    | What is known at build time              | D-16, D-18, D-19                 |
| OQ-16    | "Composition" versus "compose"           | The naming rule in `GLOSSARY.md` |
| OQ-17    | CLI surface details                      | D-29                             |

Deferred beyond v1, with no decision needed now:

- A secret param type (D-33).
- Cost, price tables, budget caps and per-adapter compaction (D-23).
- Cross-concert join (D-27).
- In-process SDK adapters (D-20).
- arm64 and macOS (D-25).
- Licensing (D-31).

## 10. Risks

- **R-1.** Symbolic build ergonomics: authors cannot branch on a Ref. Mitigation: lifting combinators, examples, a quick
  feedback loop with compose.
- **R-2.** Compose strength is bounded by schemas. Code node bodies are opaque, so declared reads and writes matter.
- **R-3.** Graphs whose shape depends on a model's output (a planner choosing lenses) are bounded, not exact.
- **R-4.** The JSON event streams of pi and Claude Code are assumed stable and sufficient. Slice 0 checks pi's (D-32).
- **R-5.** Single binary on modern Linux: a minimal binary is known to run. SQLite and external pack loading are checked
  in slice 0 (D-32). RHEL 8 is a best-effort probe (D-34).
- **R-6.** Scope creep from porting legacy features. The slice boundary (D-10) and the legacy disposition table below
  are the guard.
- **R-7.** Lane semantics are the heaviest piece to rebuild (isolated worktrees, fork and join, applying changesets,
  keeping rejected output). They live in the host and not in the core.
- **R-8.** The clean break removes byte-level comparison with the predecessor. Behavioral comparison is weaker, so the
  reference must be used deliberately (D-28).
- **R-9.** The stage name and the authored-unit name share a stem (D-12). Without the naming rule, prose and diagnostics
  blur them.

## 11. Legacy concept disposition (proposal)

Maps the predecessor's concepts to maestro's. It is based on the predecessor's multi-agent workflows (twelve, see
section 12) and the module descriptions of its 1.0.0b6 release. Items marked "unread" were identified from module
descriptions only and need a closer look during the slice.

| sssf concept                                                | maestro disposition                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| chain, three tiers (factory, workspace, pack)               | Composition. One resolution order, no tiers.                                  |
| stage vs composition                                        | Dissolves. A stage is a composition or a preset agent node shipped in a pack. |
| performance, run, leg                                       | Concert and node instance. Lane is a host resource.                           |
| `--join`, `--from`, `--base`, `--group`, `--label`, `--tag` | Lane inputs on agent nodes, and concert metadata.                             |
| `WorkflowSpec` (required agents, runs quality)              | Derived from the graph.                                                       |
| `vars` file, `.in` templates, shell-sourced values          | Typed inputs and checked prompt templates.                                    |
| sidecar JSON and `isinstance` checks                        | Typed outputs validated by the engine.                                        |
| `limits.fix_loops`                                          | A composition param (D-17).                                                   |
| "reuse output if the json exists"                           | Resume.                                                                       |
| `seat()` copied between chains, `_` helper modules          | Typed subcompositions.                                                        |
| stderr degraded-run logging                                 | `Settled` results and outcomes in the record.                                 |
| `obs` viewer (deprecated)                                   | Renderer contract on the IR and event stream.                                 |
| tool call and thinking events, streamed as each completes   | Host progress events on the node instance (CORE-10).                          |
| `seams` (pick up a previous run's record)                   | Superseded by resume and lane versions (unread).                              |
| `resolution` (what one run resolved to)                     | The plan (unread).                                                            |
| `gates` (verify an envelope's claims)                       | Re-evaluate in the host slice (unread).                                       |
| profiles and rosters (`extends:`)                           | Re-evaluate: host namespace and layered config (unread).                      |
| `safety` (what a run may bind and change)                   | Host sandbox and lane rules.                                                  |
| `quality` (target checks as code steps)                     | Check node (D-22).                                                            |

## 12. Using the predecessor as a behavioral reference (D-11)

When a checkout of the predecessor is available, it answers "what should this behavior be". Rules:

- Consult it for behavior, never for structure. Do not mirror its modules, flags or file formats.
- Areas worth consulting, by module name in the 1.0.0b6 release (locate the equivalents in the checkout): lane and
  worktree handling and series delivery (`runtime`, `repository`), the sandbox mount plan (`sandbox`, `safety`), the
  harness interface and its two adapters (`harness`, `sssf_claude`, `sssf_pi`), quality checks (`quality`), join and
  resume (`seams`), and budgets (`runtime`, cost deferred per D-23).
- Acceptance comparisons are semantic (D-28).
- The worked examples in `sdk-spec.md` derive from twelve of the predecessor's workflows: four verification and review
  chains (a verification round, a rework-then-review gate, a triage over a cross product, a review of a locking change)
  and eight general compositions (stage pipelines, build-then-repair, build with review, escalation over models, fan-out
  over models, plan panel, review panel, and the full pipeline).
