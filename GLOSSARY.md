# maestro

maestro composes and performs multi-agent workflows. A composition is code that builds a graph, the graph is checked and
bounded before any spend, and a domain-free engine carries it out. Coding-agent concerns live in a host, and domain
concerns live in packs.

Naming rule: _composition_ is always the authored unit of code. _Compose_ is the lifecycle stage, and _composed X_ means
X as produced by that stage. _Performance_ keeps its plain meaning, speed. A run of a plan is a _concert_.

## Language

### Lifecycle

**Compose**: The first stage. It parses config, builds the graph from a composition, emits the IR, and ends with
pre-flight. It spends nothing and has no side effects. _Avoid_: build (as the stage name), plan (as a verb)

**Pre-flight**: The final step of compose: the full validation of a graph before any spend. _Avoid_: dry run

**Plan**: The product of compose: the IR plus composed config, diagnostics, expansion and bounds.

**Perform**: The second stage. It starts a concert from a plan. _Avoid_: launch, and execute for the stage. A host
kind's `execute` hook carries out one node instance.

**Concert**: One run of the perform stage over a plan. It has an id, a record and a result. _Avoid_: run, execution,
performance

**Concert record**: The durable account of a concert: node instances, outcomes, artifacts, events and metrics.

**Node instance**: One concrete run of a node within a concert, identified by node id and expansion path. _Avoid_: leg

**Event**: A state transition of a node instance.

**Outcome**: How a node instance ended: `ok`, `rejected` (completed with a negative verdict), `failed` (could not
complete) or `skipped` (not run).

**Settled**: A group member's result together with its outcome: the value if present, the reason if rejected or failed.

**Metric**: A named, additive number reported by a node instance, such as `tokens_in`. The engine sums each name per
concert and attaches no meaning to it.

### Authoring

**Composition**: An authored, named unit of code that builds a graph from typed params. _Avoid_: chain, workflow,
pipeline

**Subcomposition**: A composition used inside another one, with typed params and ports. _Avoid_: helper, stage

**Params**: The plain values a composition or subcomposition takes: CLI inputs, tunables and switches. Known at build
time, so they can shape the graph. _Avoid_: inputs, config (for a composition's own tunables)

**Ports**: The Ref-typed arguments of a subcomposition, fed by upstream node outputs. _Avoid_: inputs

**Plain value**: A value known while building. Params and composed config are plain.

**Ref**: A symbolic handle to a node output, used while building. A Ref has no value until perform time and cannot drive
build-time logic. _Avoid_: variable, promise

**Example input set**: A declared set of params that lets `compose` validate a composition without flags.

**Code node**: A node that runs the author's function over typed ports and returns typed outputs. _Avoid_: script, step

**Pack**: A package of compositions, prompts, schemas, code nodes and params for one domain. _Avoid_: plugin

### Graph

**Graph**: Nodes joined by typed edges, produced by building a composition.

**IR**: The language-neutral, versioned JSON form of a graph and its metadata. It is the contract between authors and
the engine.

**Node**: A unit of the graph with a stable id, a label and typed ports. Kinds: code, group, assert and host kinds.

**Group node**: A node holding a body that is instantiated several times: `map` (parallel), `seq` (ordered, stops when
satisfied) or `repeat` (a bounded loop carrying state).

**Host node**: A node whose kind is registered by a host. The engine treats it as opaque work.

**Edge**: A dependency between ports. Kinds: `data` (a value or artifact flows), `collect` (settled results of a group
flow to one node, the explicit fan-in) and `control` (guards, tolerance, ordering).

**Reducer**: A named code node marked as fan-in, such as `firstOk` or `okOnly`.

**Artifact**: A typed file, directory or text value tracked by the engine, with provenance.

**Worker**: The context that runs code nodes of one runtime.

### Configuration

**Core config**: The small closed set of engine settings.

**Config namespace**: A top-level config key owned by a host or pack and validated by that owner's schema.

**Composed config**: Layered config as produced by compose, with each value's source layer.

### Hosts

**Host**: A plugin that registers node kinds, types, validation and bounds hooks and an environment.

**Engine**: The domain-free core: the graph model, compose checks, scheduling, cache, record and events. It knows no
host.

### Coding-agent host

**Agent node**: Runs one role against a prompt in a lane. _Avoid_: leg

**Role**: The configured identity of an agent: harness, model, thinking level and prompt includes. _Avoid_: seat

**Lane**: An isolated, versioned working copy cut from a target. An agent node takes one with `fresh`, `fork` or `join`.
_Avoid_: worktree, run

**Lane ref**: A param type naming a lane version left by an earlier concert, written `<concert id>.<node instance id>`.
It can be forked and not joined.

**Target**: The repository lanes are cut from.

**Changeset**: The patch series a concert leaves. The target's checkout is never touched. _Avoid_: series

**Harness**: The adapter to one coding-agent runtime, such as pi or Claude Code.

**Check node**: Runs deterministic commands in a lane and ends `ok`, `rejected` or `failed`, with logs. _Avoid_: quality

**Sandbox**: The confinement an agent or check runs in.
