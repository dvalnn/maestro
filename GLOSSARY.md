# maestro

maestro composes and performs multi-agent workflows. A composition is code that builds a graph, the graph is checked and
bounded before any spend, and a domain-free engine carries it out. Coding-agent concerns live in a host, and domain
concerns live in packs.

Naming rule: _composition_ is always the authored unit of code. _Compose_ is the lifecycle stage, and _composed X_ means
X as produced by that stage. _Performance_ keeps its plain meaning, speed. A run of a plan is a _concert_.

Each entry is a one-line definition; the rest of a term lives in its home, linked.

## Language

### Lifecycle

**Compose**: The first stage: parse config, build the graph, emit the IR, end with pre-flight. It spends nothing.
_Avoid_: build (as the stage name), plan (as a verb). [Home](docs/architecture.md#4-lifecycle-of-a-concert)

**Pre-flight**: The final step of compose: the full validation of a graph before any spend. _Avoid_: dry run.
[Home](packages/core/src/compose/README.md)

**Plan**: The product of compose: the IR plus composed config, diagnostics, expansion and bounds.

**Perform**: The second stage: start a concert from a plan. _Avoid_: launch, and execute for the stage. A host kind's
`execute` hook carries out one node instance.

**Concert**: One run of the perform stage over a plan, with an id, a record and a result. _Avoid_: run, execution,
performance

**Encore**: A new concert that performs an earlier one's composition again, its agents continuing their counterparts'
sessions. _Avoid_: rerun, continue. [Home](docs/architecture.md#resume-and-encore)

**Fingerprint**: A digest of a concert's IR, config values and host facts; an encore equal to its concert's is refused.
[Home](docs/architecture.md#resume-and-encore) The tour manager also fingerprints an issue's text to dedupe what it
files. [Home](docs/agents/factory.md#build)

**Short id**: A concert's display id: 8 letters of its UUIDv7 in jj's reverse-hex alphabet, more when 8 do not tell it
apart, which commands take as a prefix. [Home](packages/cli/README.md#concert-ids)

**Concert record**: The durable account of a concert: node instances, outcomes, artifacts, events and metrics.
[Home](docs/architecture.md#10-record-and-events)

**Node instance**: One concrete run of a node within a concert, identified by node id and expansion path. _Avoid_: leg

**Resume key**: What a recorded `ok` node instance is reused on at resume: a hash of its definition, code hash and
inputs. [Home](docs/architecture.md#resume-and-encore)

**Stale instance**: A row left by an earlier attempt of a resumed concert, neither reused nor replaced.

**Event**: A state transition of a node instance.

**Outcome**: How a node instance ended: `ok`, `rejected` (a negative verdict), `failed` (could not complete) or
`skipped` (not run). [Home](docs/architecture.md#node-instances-and-outcomes)

**Node result**: A node instance's outcome with its outputs, or with its reason.

**Result rule**: The walk that derives a concert's result from the node its composition returns.
[Home](docs/architecture.md#result-rule)

**Settled**: A group member's result with its outcome: the value if present, the reason if rejected or failed.
[Home](packages/ir/README.md#outcomes-and-settled)

**Metric**: A named, additive number a node instance reports, such as `tokens_in`; the engine sums it per concert and
gives it no meaning.

### Tour manager

**Tour**: A dot-separated slug grouping thematically related concerts, one per concert, for listing and pruning (`epic`
holds `epic.story`). Bookkeeping only. _Avoid_: group, tag

**Tour manager**: The Maestro Tour Manager: maestro in factory mode, which triages and builds a milestone's forge
tickets, speaking on the ticket only in comments. _Avoid_: factory (for who acts), bot. [Home](docs/agents/factory.md)

**Tick**: One run of `scripts/factory`: it reads the forge, routes what finished concerts left, and starts at most one
next action. [Home](docs/agents/factory.md)

**Settle**: A finished concert awaiting routing by the tick. [Home](docs/agents/factory.md#routing-a-settle)

**Slice**: The concert that builds one ticket's change (`.maestro/slice.ts`). [Home](docs/agents/factory.md#build)

**Stack review**: The concert that reviews a split epic's children as one change, for the seams no slice's review can
show (`.maestro/review.ts`). [Home](docs/agents/factory.md#build)

**Masterclass**: The concert that gathers lessons from settled concerts into proposals. _Avoid_: harvest.
[Home](docs/agents/factory.md#masterclass)

**Watermark**: The newest ok masterclass concert in the record; settled slice and triage concerts on milestone tours
after it count toward the next masterclass. [Home](docs/agents/factory.md#masterclass)

**Dependency**: A forge "blocked by" link between issues that sets build order. [Home](docs/agents/factory.md)

### Authoring

**Composition**: An authored, named unit of code that builds a graph from typed params. _Avoid_: chain, workflow,
pipeline. [Home](docs/sdk-spec.md#writing-a-composition)

**Subcomposition**: A composition used inside another, with typed params and ports. _Avoid_: helper, stage

**Params**: The plain values a composition takes, known at build time so they can shape the graph. _Avoid_: inputs,
config (for a composition's own tunables)

**Ports**: The Ref-typed arguments of a subcomposition, fed by upstream node outputs. _Avoid_: inputs

**Plain value**: A value known while building; params and composed config are plain.

**Ref**: A symbolic handle to a node output, valueless until perform time and unusable in build-time logic. _Avoid_:
variable, promise. [Home](docs/sdk-spec.md#refs-and-mapping-between-nodes)

**Example input set**: A declared set of params that lets `compose` validate a composition without flags.

**Code node**: A node that runs the author's function over typed ports and returns typed outputs. _Avoid_: script, step.
[Home](docs/architecture.md#9-workers-and-code-nodes)

**Pack**: A package of compositions, prompts, schemas, code nodes and params for one domain. _Avoid_: plugin.
[Home](docs/architecture.md#13-packs)

### Graph

**Graph**: Nodes joined by typed edges, produced by building a composition.

**IR**: The language-neutral, versioned JSON form of a graph and its metadata, the contract between authors and the
engine. [Home](packages/ir/README.md)

**Node**: A unit of the graph with a stable id and typed ports: code, group, assert or a host kind.

**Group node**: A node whose body is instantiated several times: `parMap`, `map`, `find`, `parFind`, `fold` or `loop`.
[Home](docs/architecture.md#groups)

**Iteration**: One pass of a `loop`, `map`, `find` or `fold` body, numbered from 0 in its expansion path. A `parMap` or
`parFind` has items, not iterations.

**On error**: What a `parMap` or `map` does at a member that is not `ok`: `stop` halts the group, `continue` runs every
item.

**Host node**: A node whose kind a host registers; the engine treats it as opaque work.

**Edge**: A dependency between ports: `data`, `collect` (a group's settled results flowing to one node) or `control`.
[Home](packages/ir/README.md#edges)

**Barrier**: A node with several distinct upstreams, shown as a multi-edge join.
[Home](docs/architecture.md#5-the-ir-contract)

**Status port**: A port every node has, `ok` or `reason`, telling how it settled. [Home](packages/ir/README.md#edges)

**Missing output**: A declared output an upstream did not produce. A node reading it is `skipped` and a condition
reading it is not true; never a crash. [Home](packages/ir/README.md#edges)

**Reducer**: A named code node marked as fan-in, such as `firstOk` or `okOnly`.

**Artifact**: A typed file, directory or text value tracked by the engine, with provenance.

**Worker**: The context that runs code nodes of one runtime.

### Configuration

**Core config**: The small closed set of engine settings. [Home](docs/architecture.md#core-keys)

**Config namespace**: A top-level config key owned by a host or pack and validated by its owner's schema.

**Registrant**: The host or pack that owns a config namespace and validates it at compose time.
[Home](docs/architecture.md#who-owns-what)

**Workspace**: The nearest ancestor of the working directory holding a `.maestro/` directory, whose config layers over
the user's. Each concert records its workspace's name. [Home](docs/architecture.md#10-record-and-events)

**Data root**: The directory holding the record store, concert areas, scratch and host stores.
[Home](docs/architecture.md#data-root)

**Composed config**: The config layers merged, with each value's source layer.

**Gap**: A setting or param a command needs and no config layer gives, such as a profile with no harness; compose marks
it with its `unset` keys, and a reading view shows it in place or reports it. Not a report's `gaps`, which lists what an
agent left undone or unverified. [Home](docs/rulings.md#cli)

### Hosts

**Host**: A plugin that registers node kinds, types, validation and bounds hooks and an environment.
[Home](docs/architecture.md#6-host-interface)

**Host setup**: What the engine gives a host in its hooks: its config namespaces' values and its own store under the
data root.

**Engine**: The domain-free core: the graph model, compose checks, scheduling, resume, record and events. It knows no
host.

**Conductor**: An agent session that drives the CLI as the operator. [Home](docs/architecture.md#2-system-context)

### Coding-agent host

**Agent node**: Runs one profile against a prompt in a lane. _Avoid_: leg.
[Home](packages/host-repo/README.md#agent-node)

**Runtime**: What an agent runs on: its harness, model and thinking level. _Avoid_: role

**Profile**: A named agent setup: runtime, instructions, attachments, binds, context policy and limits; a pack's is
named `<pack id>/<name>`. [Home](packages/host-repo/README.md#profiles-and-prompts)

**Preset**: A named config layer switched per concert (`--preset risky`), above config files and below `-c`; it tunes
profiles and rebinds seats. _Avoid_: config profile. [Home](docs/architecture.md#layers-presets-and--c)

**Shadow**: A workspace's or user's profile directory used whole in place of a pack profile of the same name. _Avoid_:
fork. [Home](packages/host-repo/README.md#lookup)

**Agent environment**: What a harness loads for an agent: tools, subagents, skills, MCP servers, hooks, context files
and compaction. Not the host's environment. [Home](packages/host-repo/README.md#environment-report-and-probe)

**Probe**: Starting a profile's harness to read its startup environment and context window. A mismatch is a fault of
inspection, never of a concert. [Home](packages/host-repo/README.md#environment-report-and-probe)

**Instructions**: An agent's standing text, appended to its harness's system prompt. _Avoid_: identity.
[Home](packages/host-repo/README.md#staging)

**Context policy**: How an agent's run resets its context as it fills: handoff or compaction.
[Home](packages/host-repo/README.md#context-policy)

**Session**: An agent's harness conversation, a `repo.session` value, continued in place by a later agent.
[Home](packages/host-repo/README.md#sessions)

**Handoff**: A context reset within one agent node: a fresh session takes over the task in the same lane. _Avoid_:
baton. [Home](packages/host-repo/README.md#handoff)

**Handoff note**: What an outgoing session leaves its successor: claims about the work, which it checks against the
lane.

**Seat**: A composition's slot for an agent: the profile it names and the outputs, verdict and checks the graph expects;
config may rebind it. [Home](docs/sdk-spec.md#repo-host-sdk)

**Envelope**: An agent's final reply, carrying a report and, for a verdict agent, an outcome.
[Home](packages/host-repo/README.md#envelope)

**Lesson**: Something the next agent in this repository should know that the code and docs do not say, listed in its
report; the owner promotes it by hand.

**Work agent**: An agent that does the work: it finishes `ok` or is blocked, and never rejects.

**Verdict agent**: An agent that rules on work, marked `verdict` on its node: `ok`, `rejected`, or blocked.

**Blocked**: An agent's report that it could not do its job for a cause outside its reach; it settles `failed` with
`blocked: <cause>`. A rejection is a verdict given after doing the job.

**Obstacle**: Something outside an agent's reach that slowed it, listed in its report; unlike Blocked, it does not stop
the run, and a red check is not one. [Home](docs/agents/factory.md#build)

**Outbox**: The per-instance directory at `/out`, outside the lane, where an agent writes its declared outputs.
[Home](packages/host-repo/README.md#outbox)

**Attachment**: A named artifact an agent reads, mounted read-only at `/in/<name>` and listed in its prompt with its
`hint`, which tells the agent when to read it; its content is in the resume key. _Avoid_: ref.
[Home](packages/host-repo/README.md#staging)

**Bind**: A host path outside the lane made visible in a sandbox at its own path; not an input, not in the resume key
(ADR 0011). [Home](packages/host-repo/README.md#sandbox)

**Lane**: An isolated, versioned working copy cut from a target; a node takes one with `fresh`, `fork`, `extend` or
`read`. _Avoid_: worktree, run. [Home](packages/host-repo/README.md#lanes)

**Lane ref**: A param type naming a lane version left by an earlier concert, `<concert id>.<node instance id>`.
[Home](packages/host-repo/README.md#lane-refs)

**Target**: The repository lanes are cut from.

**Prepare**: The target's shell lines, `target.prepare`, run in the sandbox over every lane checked out from a commit.
_Avoid_: setup, hook, after-create. [Home](packages/host-repo/README.md#prepare-and-sparse)

**Changeset**: A lane version's patch series, held as an artifact; the target's checkout is never touched. _Avoid_:
series. [Home](packages/host-repo/README.md#changesets)

**Partial**: The changes a failed, blocked or cancelled agent left in its lane, kept for recovery with `cs --partial`.
_Avoid_: salvage, leftover. [Home](packages/host-repo/README.md#partials)

**Changeset node**: Takes one lane version and outputs its changeset.
[Home](packages/host-repo/README.md#changeset-node)

**Commits node**: Takes git revisions of the target and outputs them as a lane version, forked or read, never extended.
[Home](packages/host-repo/README.md#commits-node)

**Apply node**: Applies one changeset to a lane and yields a new version; a conflict is `rejected`.
[Home](packages/host-repo/README.md#apply-node)

**Harness**: The adapter to one coding-agent runtime, such as pi or Claude Code.

**Check node**: Runs deterministic commands in a lane and ends `ok`, `rejected` or `failed`. _Avoid_: quality

**Sandbox**: The confinement an agent, a check or a prepare line runs in.
