# maestro: system requirements

For anyone checking what maestro must do and why. Code and docs cite requirements by id. Companion docs: `GLOSSARY.md`,
`architecture.md`, `sdk-spec.md`.

## Purpose and context

maestro composes and performs multi-agent coding compositions by symbolic node-graph execution. A composition is code
that builds a graph. The graph is data, checked and bounded before any spend, and carried out by a core that knows
nothing about coding agents. Everything about coding agents lives in a host. Everything about a specific domain (Gerrit,
a verification suite) lives in packs.

maestro works in two lifecycle stages, compose and perform, and nothing is spent before compose succeeds. See
[Lifecycle of a concert](architecture.md#4-lifecycle-of-a-concert).

## Decisions

The owner's decisions are in [rulings.md](rulings.md) as D-nn. Requirements cite them by id.

## Goals and non-goals

Goals:

- **G1.** Pre-flight: a whole composition is validated and its size bounded (node instances and agent runs) before any
  model spend.
- **G2.** A lean authoring API that expresses multi-agent graphs (fan-out, fan-in, bounded loops, escalation,
  conditionals) with code stages for the data plumbing that genuinely needs code.
- **G3.** A domain-free core. Hosts add node kinds, and packs add compositions.
- **G4.** A language-neutral, versioned IR as the contract between authors and the engine.
- **G5.** The graph can be rendered after compose and before any spend, and observed live during a concert.
- **G6.** Distributable on Bun, installable by others, ideally as a single executable.
- **G7.** Coding-agent harnesses integrate as sandboxed subprocesses (D-20,
  [ADR 0001](adr/0001-sandboxed-subprocess-adapters.md)).
- **G8.** Operable by agents: machine-readable CLI output, stable exit-code categories, actionable diagnostics.

Non-goals:

- YAML compositions or an expression language. Code nodes cover what an expression language would.
- Spreading one concert across machines. One machine per concert.
- A hosted service or a web UI. The renderer contract is in scope. A GUI is not.
- Node.js compatibility. Bun is the baseline (D-03).
- Cost accounting and price tables (D-23). Token counts are recorded.
- A secret param type (D-33).
- Extending a lane across concerts (D-27). Forking and reading are supported.
- macOS and arm64 (D-25).
- Publishing to a public package registry (D-31).
- SDKs in languages other than TypeScript. The IR allows them (D-09), and none is built.

## Actors

- **Operator.** A person, or a conductor agent session, who composes and performs through the CLI and observes the
  result.
- **Composition author.** Writes compositions and packs. Often an agent, so diagnostics must serve agents.
- **Host implementer.** Writes a host that gives the core new node kinds. The first host is the coding-agent host.
- **Core and SDK maintainers.**
- **Renderer author.** Consumes the IR and the event stream to draw graphs.

## Glossary

The glossary is `GLOSSARY.md`, beside this document. It is the single source for terms and for the words to avoid.
Coding-agent host terms in it are final (D-21).

## Functional requirements

Priority: **Must** is required. **Should** is wanted and may slip. **May** is optional.

### Core: graph and engine (CORE)

- **CORE-01 (Must).** The graph model has node kinds `code`, `parMap`, `map`, `find`, `parFind`, `fold`, `loop`,
  `assert` and host kinds, with `when` guards and subcomposition scopes.
- **CORE-02 (Must).** Ports are typed with schemas that serialize to JSON Schema. Compose type-checks every edge.
- **CORE-03 (Must).** The IR distinguishes edge kinds `data`, `collect` and `control`. Fan-in is an explicit `collect`
  edge or a reducer node, never inferred (D-08).
- **CORE-04 (Must).** Outcomes are `ok`, `rejected`, `failed`, `skipped`. By default a dependent runs only after `ok`
  upstreams. An edge can tolerate `rejected`, and a dependent that reads only status ports (`ok` or `reason`) of an
  upstream needs no tolerance. The concert result is the node the composition returns when it is `ok`, else the root
  cause of its outcome. A concert that fails before any node runs has a result with no node, only `failed` and the
  reason.
- **CORE-05 (Must).** Every group declares its cardinality, `exact` or `up to N`, so compose can bound node instances.
- **CORE-06 (Must).** Building is symbolic, deterministic and side-effect free. It never reads a node's value. The same
  inputs and config yield byte-identical IR.
- **CORE-07 (Must).** Compose builds, emits the IR, then runs pre-flight. It writes nothing outside a scratch area and
  spends nothing. See [Lifecycle of a concert](architecture.md#4-lifecycle-of-a-concert) and the
  [pre-flight steps](../packages/core/src/compose/README.md).
- **CORE-08 (Must).** The executor schedules node instances by dependency with a configurable concurrency cap, supports
  cancellation, and propagates outcomes per CORE-04.
- **CORE-09 (Must).** A failed or killed concert resumes at node granularity. A recorded `ok` node instance is reused
  while a content hash of its node definition, code version and inputs still matches.
- **CORE-10 (Must).** Every node-instance state transition emits an event with node id and expansion path. A host may
  emit progress events for an instance it is executing, such as an agent's tool calls and thinking, under the same keys.
  Events are durable.
- **CORE-11 (Must).** A record store holds concerts, node instances, outcomes, durations, metrics, artifacts and events,
  and supports the queries of the [CLI](#cli-cli).
- **CORE-12 (Must).** Core has no domain words (D-06). A lint and the core's own suite enforce it.
  - The suite runs real graphs with only code nodes plus a fake host kind.
  - The lint rejects the words lane, seat, leg, run, review, build and quality in the core packages (`ir`, `core`,
    `sdk`, `testkit` and `render-text`).
  - `build` is allowed in `sdk`, which drives the build phase, and in `testkit`, which tests it.
  - `cli` is held to it outside its host modules ([R-10](rulings.md#cli)).
- **CORE-13 (Must).** A host interface lets a host register node kinds, types, a `validate(graph, setup)` hook, a
  `bounds(node)` hook and an environment, per [Host interface](architecture.md#6-host-interface).
- **CORE-14 (Must).** The worker protocol is defined for code nodes. The TypeScript runtime provides an in-process
  worker. Out-of-process workers are specified and not required.
- **CORE-15 (Must).** Artifacts are first-class: typed file, directory and text, with provenance, optional values (a
  record field left out of `required`), and staging by whichever host node needs them.
- **CORE-16 (Must).** The IR carries a version and an explicit compatibility policy. A consumer rejects an unknown major
  version with a clear error.
- **CORE-17 (Should).** Diagnostics carry stable codes, the node id, the source location in the composition, and a
  suggested next step.
- **CORE-18 (Should).** Config is layered and validated per namespace per [Configuration](#configuration-cfg), and the
  composed config reports the layer each value came from.
- **CORE-19 (Must).** A node instance carries named additive numbers (metrics). The engine sums each name per concert
  and exposes the totals to the CLI. It attaches no meaning to a name (D-23), except the token sum `limits.tokens`
  bounds. The host half of the totals arrives with HOST-07.

### Configuration (CFG)

- **CFG-01 (Must).** Core config is a small closed schema of engine concerns only: concurrency cap, caps by name, the
  data root (by default under the user's XDG data home), the workspace's name and the concert's `limits`.
- **CFG-02 (Must).** Every other top-level config key belongs to a namespace owned by a registrant. The core checks YAML
  syntax, layers the files, and hands each namespace to its owner's schema at compose time (D-07).
- **CFG-03 (Must).** A composition declares typed params with defaults in code (D-17). Params live in the SDK and the
  CLI; the IR holds what they built. Subcompositions declare params and ports. A param value can end up in the IR as a
  literal, so secrets belong in config or the environment, never in params.
- **CFG-04 (Must).** A param's value resolves by the ladder in [Configuration](architecture.md#8-configuration): the CLI
  flag (root composition) or the use site (subcomposition) highest, the declared default lowest, with `-c`, presets,
  workspace and user YAML and, for `compose`, the example set between. YAML keys live under the pack id and the
  composition id (D-17).
- **CFG-05 (Should).** A config key that no installed registrant claims fails compose with a did-you-mean hint. A key
  claimed by an installed registrant that the concert does not use is ignored (D-24).
- **CFG-06 (Must).** The `config` command prints the composed config and validates it for a given composition.

### SDK (SDK)

- **SDK-01 (Must).** A TypeScript SDK declares compositions: name, doc, typed params with CLI hints and defaults, and,
  without ports, at least one example input set (D-19).
- **SDK-02 (Must).** Constructors exist for code, the iteration groups (`iter.parMap`, `iter.map`, `iter.find`,
  `iter.parFind`, `iter.fold`), the loops (`loop.while`, `loop.doWhile`), assert, subcomposition use, and for host node
  kinds contributed by host SDKs.
- **SDK-03 (Must).** `Ref` semantics are enforced: build code cannot branch on a Ref. Lifting combinators (`get`, `or`,
  `when`, `lookup`, `not`) cover the common cases, and anything else is a code node. Params and composed config are
  plain values (D-16). The types distinguish Plain from Ref, and coercing a Ref to a boolean or string during build
  throws.
- **SDK-04 (Must).** Code nodes declare typed inputs and outputs. They run only at perform (ADR 0009).
- **SDK-05 (Must).** Subcompositions have typed signatures, plain params plus Ref ports (D-16), and are reusable across
  packs.
- **SDK-06 (Must).** What a composition needs (plan node kinds, instance counts, host counts) is derived by compose and
  host `validate`, never declared by hand. No SDK function and no IR field carries it.
- **SDK-07 (Should).** A standard library supplies reducers (`firstOk`, `okOnly`, `allSettled`) and a typed JSON file
  reader (`readJson`).
- **SDK-08 (Must).** A test kit provides a fake host, build and compose assertions, and concerts with stubbed nodes.
- **SDK-09 (Should).** The SDK can emit IR to a file without performing it.
- **SDK-10 (May).** SDKs in other languages emit the same IR.
- **SDK-11 (Must).** Build runs with ambient state frozen: no environment, clock or randomness (CORE-06, D-16).
- **SDK-12 (Should).** The loader builds twice and compares the IR to catch nondeterministic build code.
- **SDK-13 (Must).** `parMap` and `parFind` items are identified by key: the value for primitive items, the index
  otherwise, or an author-supplied key function. Duplicate keys are a compose error, or a failed group when a key
  function or a list known only at perform time gives them (D-18).

### IR emitters (IR)

- **IR-01 (Must).** The IR schema is published and independent of the TypeScript SDK. A hand-written IR file is
  performed with no SDK. This proves language neutrality (acceptance AC-8).

### Coding-agent host (HOST)

- **HOST-01 (Must).** An agent node runs one profile against a prompt in a lane of a target. It produces typed outputs
  (declared files), its envelope (a report, and either the cause it is blocked by or, from a verdict agent, an outcome
  with a reason when rejected), metrics (token counts), and a lane handle.
- **HOST-02 (Must).** Lanes are versioned handles, taken as `fresh(base)`, `fork(handle)`, `extend(handle)` or
  `read(handle)`. A read spends no extension. A version may be extended at most once and forked or read any number of
  times, and a node takes exactly one lane input. A host `validate` hook enforces this. The mechanism is in
  [Lanes](../packages/host-repo/README.md#lanes).
- **HOST-03 (Must).** A concert writes only its own lanes. The target's checkout, refs and commits are untouched.
  Results leave only as a changeset node's output.
- **HOST-04 (Must).** An agent runs sandboxed: writable only in its lane, its outbox, its session directory and the
  writable binds of the checks it may run; read-only binds declared by the node, config or those checks, and the
  artifacts it reads as attachments; secrets never written to logs, events or records.
- **HOST-05 (Must).** A harness adapter interface exists. An adapter drives its harness as a sandboxed subprocess (D-20,
  [ADR 0001](adr/0001-sandboxed-subprocess-adapters.md)). pi is the first adapter. A Claude Code adapter is a Should.
- **HOST-06 (Must).** Prompts of any size reach the agent without hitting argument-length limits.
- **HOST-07 (Must).** Adapters report token counts as metrics per node instance, and the engine sums them per concert
  (CORE-19). There is no cost or price table in v1 (D-23).
- **HOST-08 (Must).** An agent may carry limits on its wall clock and its tokens, enforced by the host over its whole
  run. Passing one cancels the agent, which ends `failed` naming the limit. A concert's own `limits` bound the whole
  concert the same way, and cancel it as `kill` does.
- **HOST-09 (Must).** A check node (D-22) runs deterministic commands in a lane and returns pass or fail (`rejected`)
  with logs as artifacts, and a writable output directory (`MAESTRO_CHECK_OUTPUT`) kept as an artifact.
- **HOST-10 (Must).** `kill` terminates agent process trees and the record stays consistent.
- **HOST-11 (Must).** The host's compose-time hook enforces lane rules and bind validity.
- **HOST-12 (Should).** The host owns the `target`, `profiles` and `sandbox` config namespaces.
- **HOST-13 (Must).** A lane ref param type names a lane version left by an earlier concert, written
  `<concert id>.<node instance id>`. Across concerts it can only be forked, read or made into a changeset. Lanes stay on
  disk until `prune` removes them, and `ls` shows their disk use (D-27).
- **HOST-14 (Must).** An apply node applies one changeset to a lane, three-way by default or clean only. A clean apply
  yields a new lane version. A conflict is rejected naming the files and leaves a version, holding conflict markers
  where git can write them, for an agent to extend and resolve.
- **HOST-15 (Should).** An agent can run the target's named checks. The `check` command in its sandbox runs a named
  check in the lane with the check's timeout, if any, and exit classification, prints the tail of its output, and ends
  ok, rejected or failed. An agent gets the command only for the checks it names, and its frame lists each by name and
  hint and tells it to run them rather than write its own. A check's env applies inside the command alone.
- **HOST-16 (Must).** A target can name `prepare` and `sparse`, both applied to every working copy the host checks out
  from a commit.
  - `prepare` is shell lines in a check's shape, run in the sandbox before the node's work, on every kind: for a
    dependency sync and the like. A failing line fails the node, and so does a prepare that changes content a seal would
    record.
  - `sparse` is directories, or non-cone `{ patterns }`, which the host narrows each working copy to before prepare
    runs.

### CLI (CLI)

The executable is `maestro`. Commands, flags, aliases and exit codes are in `maestro --help`.

- **CLI-01 (Must).** `compose <composition>` takes a composition (a file, or a pack's composition by name) and its
  params, derived from the param schema, and runs the full compose stage including pre-flight. By default it is an
  explicit validation step: it reports diagnostics and exits with a category code, and starts no node instance.
  Optionally it saves the IR with `--out <file>`. With no params given it uses the first example input set (D-19). It
  prints diagnostics and a one-line plan summary by default, and `--graph` and `--plan` print more (D-29).
- **CLI-02 (Must).** `perform <composition | IR file>` starts a concert, announces `concert <id>` on stderr and prints
  the result's outputs on stdout. A composition is run through the compose subsystem first. An IR file is not built, and
  still goes through pre-flight (NFR-02). An error-severity diagnostic stops it before any node instance starts.
  `perform` can also re-enter an earlier concert to resume it (CORE-09). Resume is `resume <concert id>`. `perform`
  tells a composition from an IR file by extension (`.ts` or `.js` versus `.json`). `perform` never uses example input
  sets. Performing an IR file with no SDK is AC-8.
- **CLI-03 (Must).** `ls`, `wait`, `kill`, `config`, `prune` and `tour` exist. `prune` removes concerts and their lanes.
  `tour` groups concerts, and `ls` and `prune` filter by tour.
- **CLI-04 (Must).** Every command supports machine-readable output, but `changeset` and `artifact show` take no
  `--json`: their output is the content itself. Exit codes are stable and distinguish accepted, rejected, failed, usage
  error and wait timeout.
- **CLI-05 (Must).** `watch` draws the live graph.
- **CLI-06 (Must).** An error names what the operator or agent should do next.
- **CLI-07 (Must).** Every verb except `ls` and `prune` has a built-in short alias, shown in `--help`. Aliases are
  explicit and not inferred from unambiguous prefixes, so adding a verb never changes the meaning of an existing alias.
  Aliases are unique and stable across versions.
- **CLI-08 (Must).** `repertoire` lists installed packs and their compositions, and shows one composition in full.
  - With no argument it lists each pack with its version, its directory and the config file that lists it, and each
    composition with the first line of its doc.
  - Given `<pack>.<composition>` it shows the full doc, each param as its kebab-case flag with its type, default or
    `required` and description, the config entries its host nodes read by name and a `perform` line with the required
    flags.
  - A pack that fails to load is named on stderr, the rest are listed, and the exit is non-zero.
  - `compose --help` and `perform --help` given a composition add the same params block.
- **CLI-09 (Must).** The CLI loads `$XDG_CONFIG_HOME/maestro/.env` when it exists, a variable already set in the
  environment winning. The release binary loads no `.env` or `bunfig.toml` from the cwd.

### Packs and distribution (PACK, DIST)

- **PACK-01 (Must).** A pack is a pre-bundled directory or release tarball (D-30, [ADR 0002](adr/0002-pack-bundles.md)).
  Config lists packs by path, every directory under `$XDG_DATA_HOME/maestro/packs/` is one too, and a pack in both loads
  once. A pack contributes compositions, prompts, schemas, code nodes and params.
- **PACK-02 (Must).** A pack declares a semver range on the SDK it uses. Ranges on host packages wait until hosts carry
  versions.
- **PACK-03 (Must).** Domain concepts never leak into core or host packages. Packs may be domain-specific.
- **DIST-01 (Must).** The baseline runtime is Bun.
- **DIST-02 (Should).** A single executable via `bun build --compile`, on modern Linux (D-34).
- **DIST-03 (Must).** The repository is a monorepo of separately versioned packages with an independently versioned IR.
- **DIST-04 (Must).** No network use beyond harness and model traffic and explicit installs.
- **DIST-05 (Must).** Distribution is internal (D-31): release artifacts (the `maestro` binary and package tarballs)
  served from a private forge. Nothing is published to a public registry.

### Agent tool (AT)

The agent tool answers one question for any agent on any harness: what does its environment look like when it runs? A
**profile** is the named setup behind an agent, and a **seat** is a composition's slot that names one.

- **AT-01 (Must).** An adapter loads its harness clean: the built-in tools it names at launch and no others, whatever
  the harness's defaults, with no user skills, MCP servers, hooks, context files, memory or agent profiles, and subagent
  tools off where the harness allows. The baseline is fixed in the adapter, not a profile field.
- **AT-02 (Must).** Anything beyond the baseline is opt-in and owned by maestro, never read from the user's harness
  directories. Skills ride as attachments. `skills` and `mcp` are reserved profile keys and the schema rejects them with
  `profile <name>: <key> is reserved, not yet supported`.
- **AT-03 (Must).** A profile is a named roster entry bound to one harness. Its fields are
  `runtime { harness, model, thinking }`, `instructions` (one file, appended to the harness's system prompt),
  `attachments`, `readOnly` binds, `limits { timeout, tokens }` and `context`. It has no tools or permissions field:
  maestro's sandbox is the one permission boundary. A field its harness cannot honour is a pre-flight error naming the
  profile, the field and the harness.
- **AT-04 (Must).** A seat names one profile, and config may rebind it per composition, through `seats:` keyed
  `<composition id>/<seat>`. There are no ad-hoc profiles. A call sets no runtime, limits or context.
- **AT-05 (Must).** One command shows a profile's effective environment, declared and, on request and where the harness
  reports it, observed. A mismatch is a fault of inspection, recorded in a concert and never enforced: no node instance
  fails on it.
- **AT-06 (Must).** Agent identity outside composition code has one config surface: a profile directory led by its
  `profile.yaml`, tuned in YAML config under `profiles:`. Layers, later winning: the profile directory, user config,
  workspace config, each preset in the order given, `-c`. The highest root wins a name whole: workspace, then user, then
  pack.
- **AT-07 (Must).** A profile's `context` block picks one reset strategy, `handoff` or the harness's `compact`, a
  trigger `at` and a total cap `max`, required for `handoff`. There is no chain between strategies. Without a block the
  harness compacts on its own terms.
- **AT-09 (Must).** An agent may continue an earlier harness session instead of rediscovering. Within a concert an agent
  node takes `session: x.out.session`. Across concerts `encore <concert>` continues each matched agent. A continued
  agent is told what changed since its last turn.

## Non-functional requirements

- **NFR-01 Determinism.** Build and compose are deterministic. Execution order within a concert may vary inside the
  dependency partial order, and results must not depend on it.
- **NFR-02 No spend before validation.** A composition that fails compose starts no agent node.
- **NFR-03 Responsiveness (proposed targets).** Compose of a 200-node graph under 1 s. Cold start of `ls` under 150 ms.
- **NFR-04 Reliability.** A crash or kill leaves a record that resume can continue from. Code nodes time out and cancel.
- **NFR-05 Security.** Sandbox by default. Secrets are not logged. Packs run operator-trusted code, and this is
  documented.
- **NFR-06 Testability.** The core runs without a host. A host runs without real agents (stub harness).
- **NFR-07 Observability.** Every node instance is traceable from the CLI by id. The event stream is the single source
  for live views.
- **NFR-08 Portability.** Linux x64 is the only platform (D-25). The baseline and the RHEL 8 stance are
  [ADR 0003](adr/0003-modern-linux-baseline.md).
- **NFR-09 Leanness.** Each new node kind, edge kind or SDK primitive needs a written justification. The default answer
  is a code node or a stdlib helper.

## Acceptance criteria

- **AC-1.** The core test suite passes with no host and no domain words (CORE-12). Pinned by the compose test "composes
  the %s golden IR into its plan golden", over core-only fixtures, and the domain-words lint.
- **AC-2.** Composing `panel_review` (the lens, skeptic, consolidator shape) reports the exact node-instance count and
  rejects an unclaimed config key. A composition can refuse its params at build time, before any spend, carried by the
  host-repo-sdk example, whose test pins a refused param.
- **AC-3.** `build_then_repair` shows its bounded unroll in the plan. With a stub host that rejects once then accepts,
  it performs to completion, and a killed concert resumes at node granularity without repeating an `ok` node.
- **AC-4.** With one real harness, `build_then_repair` is performed on a toy target. It leaves a changeset and the
  target's checkout is untouched.
- **AC-5.** Compose renders both compositions as a graph showing fan-out, fan-in, loop bounds and conditionals.
- **AC-6.** `compose`, `perform`, `ls`, `wait`, `kill` and `config` work with JSON output, the documented exit codes and
  their short aliases.
- **AC-7.** The package installs and runs on a modern Linux host, as `bunx` or as a single binary.
- **AC-8.** A hand-written IR file is performed without the SDK. Pinned by the CLI test "a golden IR file performs
  through the CLI".
- **AC-10.** Two lanes forked from one version, each changing a different file, merge by apply into one version holding
  both changes. When both change the same lines the apply is rejected naming the file, and an agent extending its
  version can resolve it.

## Risks

- **RISK-1.** Symbolic build ergonomics: authors cannot branch on a Ref. Mitigation: lifting combinators, examples, a
  quick feedback loop with compose.
- **RISK-2.** Compose strength is bounded by schemas. Code node bodies are opaque, so their typed ports are all compose
  can check.
- **RISK-3.** Graphs whose shape depends on a model's output (a planner choosing lenses) are bounded, not exact.
- **RISK-4.** The JSON event streams of pi and Claude Code are assumed stable and sufficient.
- **RISK-5.** Single binary on modern Linux: SQLite in WAL mode and external pack loading must work inside it. RHEL 8 is
  best-effort (D-34).
- **RISK-6.** Scope creep. The non-goals are the guard.
- **RISK-7.** Lane semantics are the heaviest piece to build (isolated worktrees, fork and extend, applying changesets,
  keeping rejected output). They live in the host and not in the core.
- **RISK-8.** The stage name and the authored-unit name share a stem (D-12). Without the naming rule, prose and
  diagnostics blur them.
