# maestro

maestro composes and performs multi-agent workflows. A composition is code that builds a graph, the graph is checked and
bounded before any spend, and a domain-free engine carries it out. Coding-agent concerns live in a host, and domain
concerns live in packs.

Naming rule: _composition_ is always the authored unit of code. _Compose_ is the lifecycle stage, and _composed X_ means
X as produced by that stage. _Performance_ keeps its plain meaning, speed. A run of a composed graph is a _concert_.

Each entry is a one-line definition; the rest of a term lives in its home, linked.

## Language

### Lifecycle

**Compose**: The first stage: resolve config, build a composition's graph or load an IR file, and check it, ending with
pre-flight; it spends nothing. [Home](docs/architecture.md#4-lifecycle-of-a-concert) _Avoid_: build (as the stage name),
plan (as a verb)

**Pre-flight**: The final step of compose: the full validation of a graph before any spend.
[Home](packages/core/src/compose/README.md) _Avoid_: dry run

**Plan**: The product of compose: the IR with its group expansion, bounds and diagnostics.
[Home](packages/ir/README.md#plan)

**Perform**: The second stage: carry out a composed graph as a concert. _Avoid_: launch, execute (a host kind's
`execute` hook carries out one node instance, not a stage)

**Concert**: One run of the perform stage over a graph, with an id, a record and a result. _Avoid_: run, execution,
performance

**Encore**: A new concert that performs an earlier one's composition again, its agents continuing their counterparts'
sessions. [Home](docs/architecture.md#resume-and-encore) _Avoid_: rerun, continue

**Fingerprint**: A digest of a concert's IR, config values and host facts.
[Home](docs/architecture.md#resume-and-encore)

**Short id**: A concert's display id, shown in place of its UUIDv7 and taken by commands as a prefix.
[Home](packages/cli/README.md#concert-ids)

**Concert record**: The durable account of a concert: node instances, outcomes, artifacts, events and metrics.
[Home](docs/architecture.md#10-record-and-events)

**Node instance**: One concrete run of a node within a concert, identified by node id and expansion path. _Avoid_: leg

**Resume key**: What a recorded `ok` node instance is reused on at resume: its definition, code and inputs.
[Home](docs/architecture.md#resume-and-encore)

**Stale instance**: A row left by an earlier attempt of a resumed concert, neither reused nor replaced.
[Home](docs/architecture.md#10-record-and-events)

**Event**: A state transition of a node instance.

**Outcome**: How a node instance ended: `ok`, `rejected` (a negative verdict), `failed` (could not complete) or
`skipped` (not run). [Home](docs/architecture.md#node-instances-and-outcomes)

**Node result**: A node instance's outcome with its outputs, or with its reason.

**Result rule**: The walk that derives a concert's result from the node its composition returns.
[Home](docs/architecture.md#result-rule)

**Metric**: A named, additive number a node instance reports, such as `tokens_in`, which the engine sums per concert.
[Home](docs/architecture.md#10-record-and-events)

### Tour manager

**Tour**: A dot-separated slug grouping thematically related concerts, for listing and pruning (`epic` holds
`epic.story`). [Home](packages/cli/README.md#tours-and-durations) _Avoid_: group, tag

**Tour manager**: The Maestro Tour Manager: maestro in factory mode, which triages and builds a milestone's forge
tickets, speaking on a ticket only in comments. [Home](docs/agents/factory.md) _Avoid_: factory (for who acts), bot

**Tick**: One run of `scripts/factory`: it reads the forge, routes what finished concerts left, and starts what may run
next. [Home](docs/agents/factory.md)

**Settle**: A finished concert awaiting routing by the tick. [Home](docs/agents/factory.md#routing-a-settle)

**Slice**: The concert that builds one ticket's change (`.maestro/slice.ts`). [Home](docs/agents/factory.md#build)

**Stack review**: The concert that reviews a split epic's children as one change (`.maestro/review.ts`).
[Home](docs/agents/factory.md#build)

**Masterclass**: The concert that gathers lessons from settled concerts into proposals.
[Home](docs/agents/factory.md#masterclass) _Avoid_: harvest

**Watermark**: The newest ok masterclass concert in the record, from which the next masterclass counts.
[Home](docs/agents/factory.md#masterclass)

**Dependency**: A forge "blocked by" link between issues that sets triage and build order.
[Home](docs/agents/factory.md)

### Authoring

**Composition**: An authored, named unit of code that builds a graph from typed params.
[Home](docs/sdk-spec.md#writing-a-composition) _Avoid_: chain, workflow, pipeline

**Subcomposition**: A composition used inside another, with typed params and ports. _Avoid_: helper, stage

**Params**: The plain values a composition takes, known at build time so they can shape the graph. _Avoid_: inputs,
config (for a composition's own tunables)

**Ports**: The Ref-typed arguments of a subcomposition, fed by upstream node outputs. _Avoid_: inputs

**Plain value**: A value known while building; params and composed config are plain.

**Ref**: A symbolic handle to a node output, valueless until perform time.
[Home](docs/sdk-spec.md#refs-and-mapping-between-nodes) _Avoid_: variable, promise

**Example input set**: A declared set of params that lets `compose` validate a composition without flags.

**Code node**: A node that runs the author's function over typed ports and returns typed outputs.
[Home](docs/architecture.md#9-workers-and-code-nodes) _Avoid_: script, step

**Pack**: A package of compositions, prompts, schemas, code nodes and params for one domain.
[Home](docs/architecture.md#13-packs) _Avoid_: plugin

### Graph

**Graph**: Nodes joined by typed edges, produced by building a composition.

**IR**: The language-neutral, versioned JSON form of a graph and its metadata, the contract between authors and the
engine. [Home](packages/ir/README.md)

**Node**: A unit of the graph with a stable id and typed ports: code, group, assert or a host kind.

**Group node**: A node whose body is instantiated several times: `parMap`, `map`, `find`, `parFind`, `fold` or `loop`.
[Home](docs/architecture.md#groups)

**Iteration**: One pass of a `loop`, `map`, `find` or `fold` body, numbered from 0; a `parMap` or `parFind` has items,
not iterations.

**On error**: What a `parMap` or `map` does at a member that is not `ok`: `stop` the group or `continue`.
[Home](docs/architecture.md#groups)

**Host node**: A node whose kind a host registers; the engine treats it as opaque work.

**Edge**: A dependency between ports: `data`, `collect` (a group's settled results flowing to one node) or `control`.
[Home](packages/ir/README.md#edges)

**Barrier**: A node with several distinct upstreams, shown as a multi-edge join.
[Home](docs/architecture.md#5-the-ir-contract)

**Status port**: A port every node has, `ok` or `reason`, telling how it settled. [Home](packages/ir/README.md#edges)

**Missing output**: A declared output an upstream did not produce, as when it rejected without outputs.
[Home](packages/ir/README.md#edges)

**Settled**: A group member's result with its outcome: the value if present, the reason if rejected or failed.
[Home](packages/ir/README.md#outcomes-and-settled)

**Reducer**: A named code node marked as fan-in, such as `firstOk` or `okOnly`.

**Artifact**: A typed file, directory or text value tracked by the engine, with provenance.

**Worker**: The context that runs code nodes of one runtime.

### Configuration

**Core config**: The small closed set of engine settings. [Home](docs/architecture.md#core-keys)

**Config namespace**: A top-level config key owned by a host or pack and validated by its owner's schema.

**Registrant**: The host or pack that owns a config namespace. [Home](docs/architecture.md#who-owns-what)

**Workspace**: The nearest ancestor of the working directory holding a `.maestro/` directory, whose config layers over
the user's. [Home](docs/architecture.md#8-configuration)

**Data root**: The directory holding the record store, concert areas, scratch and host stores.
[Home](docs/architecture.md#data-root)

**Composed config**: The config layers merged, with each value's source layer.

**Gap**: A setting or param a command needs and no config layer gives, such as a profile with no harness. Not a report's
`gaps`, which lists what an agent left undone or unverified. [Home](docs/rulings.md#cli)

### Engine and hosts

**Engine**: The domain-free core: the graph model, compose checks, scheduling, resume, record and events. It knows no
host.

**Host**: A plugin that registers node kinds, types, validation and bounds hooks and an environment.
[Home](docs/architecture.md#6-host-interface)

**Host setup**: What the engine gives a host in its hooks: its config namespaces' values and its own store under the
data root.

**Conductor**: An agent session that drives the CLI as the operator. [Home](docs/architecture.md#2-system-context)

### Agents

**Agent node**: A node that runs one profile against a prompt in a lane. [Home](packages/host-repo/README.md#agent-node)
_Avoid_: leg

**Harness**: The adapter to one coding-agent runtime, such as pi or Claude Code.

**Runtime**: What an agent runs on: its harness, model and thinking level. _Avoid_: role

**Agent environment**: What a harness loads for an agent: tools, subagents, skills, MCP servers, hooks, context files
and compaction. Not the host's environment. [Home](packages/host-repo/README.md#environment-report-and-probe)

**Probe**: Starting a profile's harness to read its startup environment and context window.
[Home](packages/host-repo/README.md#environment-report-and-probe)

**Instructions**: An agent's standing text, appended to its harness's system prompt.
[Home](packages/host-repo/README.md#staging) _Avoid_: identity

**Seat**: A composition's slot for an agent: the profile it names and the outputs, verdict and checks the graph expects;
config may rebind it. [Home](docs/sdk-spec.md#repo-host-sdk)

**Work agent**: An agent that does the work: it finishes `ok` or is blocked, and never rejects.

**Verdict agent**: An agent that rules on work, marked `verdict` on its node: `ok`, `rejected`, or blocked.

**Blocked**: An agent's report that it could not do its job for a cause outside its reach; a rejection is a verdict
given after doing the job. [Home](packages/host-repo/README.md#envelope)

**Obstacle**: Something outside an agent's reach that slowed it, listed in its report; unlike Blocked, it does not stop
the run, and a red check is not one. [Home](docs/agents/factory.md#build)

**Lesson**: Something the next agent in this repository should know that the code and docs do not say, listed in its
report; a masterclass proposes its promotion and the owner approves it.

**Envelope**: An agent's final reply, carrying a report, the typed fields its seat call declares and, for a verdict
agent, an outcome. [Home](packages/host-repo/README.md#envelope)

**Relay**: A value an earlier node produced, a typed field or a Markdown output, that a composition inlines into a later
agent's task. [Home](packages/host-repo/README.md#task-layout) _Avoid_: handoff, which is a context reset within one
node.

**Task**: The text an agent node runs against: what the call asks, its inputs by name, its outputs and its bar.
[Home](packages/host-repo/README.md#task-layout) _Avoid_: task prompt

**Checklist**: The items an agent must rule on one by one, written into its task by the composition: each item met, or
broken with where. _Avoid_: skill, which names a harness's own agent-picked guidance

**Attachment**: A named artifact an agent reads, mounted read-only and listed in its task with its `hint`, type and
size; the agent must read it. [Home](packages/host-repo/README.md#staging) _Avoid_: ref

**Sighting**: A defect or smell in the target outside the task's scope, listed in an agent's report with where it is and
what it breaches, for a masterclass to cluster and raise; it never blocks the task. Unlike an Obstacle, it did not slow
the agent.

**Outbox**: The per-instance directory outside the lane where an agent writes its declared outputs.
[Home](packages/host-repo/README.md#outbox)

**Session**: An agent's harness conversation, continued in place by a later agent.
[Home](packages/host-repo/README.md#sessions)

**Context policy**: How an agent's run resets its context as it fills: handoff or compaction.
[Home](packages/host-repo/README.md#context-policy)

**Handoff**: A context reset within one agent node: a fresh session takes over the task in the same lane.
[Home](packages/host-repo/README.md#handoff) _Avoid_: baton

**Handoff note**: What an outgoing session leaves its successor: claims about the work, which it checks against the
lane.

### Profiles

**Profile**: A named agent setup: runtime, instructions, attachments, binds, context policy and limits; a pack's is
named `<pack id>/<name>`. [Home](packages/host-repo/README.md#profiles-and-prompts)

**Preset**: A named config layer switched per concert, above config files and below `-c`; it tunes profiles and rebinds
seats. [Home](docs/architecture.md#layers-presets-and--c) _Avoid_: config profile

**Namespace directory**: The directory that holds a profile's directory, such as `<root>/profiles/`, and bounds the
paths its `profile.yaml` names. [Home](packages/host-repo/README.md#fields) _Avoid_: profile root

**Shadow**: A workspace's or user's profile directory used whole in place of a pack profile of the same name.
[Home](packages/host-repo/README.md#lookup) _Avoid_: fork

**Harness extras**: The one directory a profile names in `harnessExtras`, copied into the harness's own config dir for
the session. [Home](packages/host-repo/README.md#harness-extras)

**Bind**: A host path outside the lane made visible in a sandbox at its own path; not an input.
[Home](packages/host-repo/README.md#sandbox)

### Lanes and changesets

**Target**: The repository lanes are cut from.

**Lane**: An isolated, versioned working copy cut from a target. [Home](packages/host-repo/README.md#lanes) _Avoid_:
worktree, run

**Lane ref**: A param type naming a lane version left by an earlier concert.
[Home](packages/host-repo/README.md#lane-refs)

**Prepare**: The target's shell lines, `target.prepare`, run in the sandbox over every lane checked out from a commit.
[Home](packages/host-repo/README.md#prepare-and-sparse) _Avoid_: setup, hook, after-create

**Changeset**: A lane version's patch series, held as an artifact. [Home](packages/host-repo/README.md#changesets)
_Avoid_: series

**Partial**: The changes a failed, blocked or cancelled agent left in its lane, kept for recovery.
[Home](packages/host-repo/README.md#partials) _Avoid_: salvage, leftover

**Changeset node**: A node that takes one lane version and outputs its changeset.
[Home](packages/host-repo/README.md#changeset-node)

**Commits node**: A node that takes git revisions of the target and outputs them as a lane version.
[Home](packages/host-repo/README.md#commits-node)

**Apply node**: A node that applies one changeset to a lane and yields a new version.
[Home](packages/host-repo/README.md#apply-node)

### Checks and sandbox

**Check node**: A node that runs deterministic commands in a lane and ends `ok`, `rejected` or `failed`. _Avoid_:
quality

**Sandbox**: The confinement an agent, a check or a prepare line runs in.

### Review

**Finding**: One issue a lens raises in a change: where it is, what is wrong, and the guideline it cites.

**Lens**: A verdict agent that reviews a change from one topic and lists its findings. _Avoid_: reviewer.

**Skeptic**: A verdict agent that rules on another agent's findings, upholding or dismissing each.

**Consolidator**: A work agent that replies its ruling on the spec and the lenses' upheld findings as a `verdict` field,
naming findings by id, never rewording them.

**Upheld**: A finding that survived the skeptic and the consolidator, or a criterion the consolidator ruled not met,
still to be fixed.

**Panel**: Lenses over one change, with their skeptics and an optional consolidator, ending in a tally. _Avoid_: round,
review.

**Tally**: A panel's result: the upheld findings, whether none remain, and the lane and session a fix continues.
_Avoid_: round.

**Risk**: Triage's rating of a ticket before the build, `low`, `medium` or `high`, from the paths it will touch and the
contracts it names; it decides whether tests come first and the lowest review tier. _Avoid_: tier.

**Review tier**: How strong a panel's lenses are, picked from the size of the change and never below its risk's floor.
_Avoid_: risk.

**Tester**: A work agent that pins the ask's behaviour in tests before the builder starts, listing them in a test map.

**Test map**: The tester's list of the tests it pinned, each with its file, its name and what it misses.
