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

**Short id**: A concert's display id: the last 15 hex digits of its UUIDv7 written in jj's reverse-hex letters (`0` to
`f` as `z` to `k`), shown 8 letters long. Commands take a prefix of it or of the full id; the record, paths, lane refs
and `--json` hold the full id.

**Concert record**: The durable account of a concert: node instances, outcomes, artifacts, events and metrics.

**Node instance**: One concrete run of a node within a concert, identified by node id and expansion path. _Avoid_: leg

**Resume key**: What a recorded `ok` node instance is reused on when its concert resumes: a hash of the node definition,
its current code hash and its input values with artifact content hashes.

**Stale instance**: A node instance row left by an earlier attempt of a resumed concert, which the resume has neither
reused nor replaced.

**Event**: A state transition of a node instance.

**Outcome**: How a node instance ended: `ok`, `rejected` (completed with a negative verdict), `failed` (could not
complete) or `skipped` (not run).

**Node result**: How a node instance ended: its outcome with its outputs, or with its reason.

**Settled**: A group member's result together with its outcome: the value if present, the reason if rejected or failed.

**Tour**: A group of thematically related concerts, one per concert, for listing and pruning them together. Bookkeeping
only. _Avoid_: group, tag

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

**Node**: A unit of the graph with a stable id and typed ports. Kinds: code, group, assert and host kinds.

**Group node**: A node holding a body that is instantiated several times. Kinds:

- `parMap` (one instance per item, all at once) and `map` (in order), which collect every member as `Settled`;
- `find` (in order, up to the first member meeting a condition) and `parFind` (all at once, the first to meet it wins);
- `fold` (in order, carrying an accumulator shaped like a node's result from item to item);
- `loop` (a bounded loop carrying state shaped like a node's result, going on while its test holds).

**On error**: What a `parMap` or `map` does at a member that is not `ok`: `stop` halts the group, `continue` runs every
item.

**Host node**: A node whose kind is registered by a host. The engine treats it as opaque work.

**Edge**: A dependency between ports. Kinds: `data` (a value or artifact flows), `collect` (settled results of a group
flow to one node, the explicit fan-in) and `control` (guards, tolerance, ordering).

**Status port**: A port every node has, `ok` or `reason`, telling how it settled. A node that reads only status ports of
a `rejected` upstream starts with no tolerance.

**Missing output**: A declared output an upstream did not produce, as when it rejected without outputs. A node that
reads it is `skipped` with that upstream as its cause, and a condition that reads it reads not true; it is never a
crash.

**Reducer**: A named code node marked as fan-in, such as `firstOk` or `okOnly`.

**Artifact**: A typed file, directory or text value tracked by the engine, with provenance.

**Worker**: The context that runs code nodes of one runtime.

### Configuration

**Core config**: The small closed set of engine settings.

**Config namespace**: A top-level config key owned by a host or pack and validated by that owner's schema.

**Workspace**: The nearest ancestor of the working directory holding a `.maestro/` directory, whose config layers over
the user's. Each concert records its workspace's name.

**Data root**: The directory holding the record store, concert areas, scratch and host stores. By default in the user's
XDG data home; a workspace can point it elsewhere.

**Composed config**: The config layers merged, with each value's source layer. Compose reads it.

### Hosts

**Host**: A plugin that registers node kinds, types, validation and bounds hooks and an environment, and optionally
parses its types' params and, through its resources, releases what a concert held and reports its disk use.

**Host setup**: What the engine gives a host in its hooks: the values of the config namespaces the host owns, and its
store, a directory of its own under the data root.

**Engine**: The domain-free core: the graph model, compose checks, scheduling, resume, record and events. It knows no
host.

### Coding-agent host

**Agent node**: Runs one role against a prompt in a lane. _Avoid_: leg

**Role**: The runtime an agent runs on: harness, model and thinking level.

**Identity**: An agent's standing text, appended to its harness's own system prompt from a staged file. The task goes
separately, as the user message.

**Seat**: An agent's standing setup, its role, identity, attachments, declared outputs, checks and read-only binds,
bundled once and called with a task and a lane to emit an agent node. A call may override the role and add to the rest.

**Envelope**: An agent's final reply. A work agent's is `{ report, blocked? }`. A verdict agent's is
`{ report, outcome: ok | rejected, reason? }`, the reason required when rejected, or `{ report, blocked }`.

**Work agent**: An agent that does the work, such as a builder or a planner. It finishes `ok` or is blocked, and never
rejects.

**Verdict agent**: An agent that rules on work, such as a lens or a consolidator, marked `verdict` on its node. It gives
`ok` or `rejected`, or is blocked.

**Blocked**: An agent's report that it could not do its job: the cause is outside its reach and nothing later in the
concert will change it. It settles the agent `failed` with the reason `blocked: <cause>`. A rejection, by contrast, is a
verdict given after doing the job.

**Outbox**: The per-instance directory at `/out`, outside the lane, where an agent writes its declared outputs for the
host to read and check.

**Attachment**: A named artifact an agent reads, mounted read-only at `/in/<name>` and listed in its prompt with its
`hint`, which tells the agent when to read it. Its content is in the resume key. _Avoid_: ref

**Bind**: A host path outside the lane made visible in a sandbox at its own path, read-only or, for a check or a prepare
line, read-write. It is not an input and not in the resume key (ADR 0011).

**Lane**: An isolated, versioned working copy cut from a target. A node takes one with `fresh`, `fork`, `extend` or
`read`. _Avoid_: worktree, run

**Lane ref**: A param type naming a lane version left by an earlier concert, written `<concert id>.<node instance id>`.
It can be forked, read or made into a changeset, and not extended.

**Target**: The repository lanes are cut from.

**Prepare**: The target's shell lines, `target.prepare`, that set up every lane the host checks out from a commit, such
as a dependency sync, in the sandbox before the node's work. A sparse checkout is `target.sparse`, directories or
`{ patterns }`, which the host applies. _Avoid_: setup, hook, after-create

**Changeset**: A lane version's patch series, held as an artifact. A concert leaves one only by ending in a changeset
node. The target's checkout is never touched. _Avoid_: series

**Changeset node**: Takes one lane version and outputs its changeset. It opens no lane and spends no extension.

**Commits node**: Takes git revisions of the target and outputs the commits they name as a lane version, resolved once.
It opens no lane, and its version is forked or read, never extended.

**Apply node**: Applies one changeset to a lane and yields a new version. A conflict is `rejected`, naming the files,
and leaves a version holding the markers for an agent to extend.

**Harness**: The adapter to one coding-agent runtime, such as pi or Claude Code.

**Check node**: Runs deterministic commands in a lane and ends `ok`, `rejected` or `failed`, with logs. _Avoid_: quality

**Sandbox**: The confinement an agent, a check or a prepare line runs in.
