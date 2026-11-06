# Rulings

The decision register, for anyone who needs to know what the owner settled and why.

A decision belongs here when the owner made it and no requirement states it. A decision that weighed alternatives is an
ADR in [`adr/`](adr/), and this file links it. A ruling that grows into a design moves to an ADR and leaves this file.

D-01, D-02, D-10, D-11, D-14, D-28 and D-32 are retired. Numbers are never reused.

## Decisions

A decision sets direction; a ruling settles a question the requirements left open.

- **D-03** TypeScript on Bun, distributable and tied to no workspace, machine or checkout. Why: code nodes in the
  authoring language tip the balance, and a Rust core would still need a TypeScript runtime for them.
- **D-04** Compositions are code in a lean SDK that builds a graph, never YAML; YAML is for configuration only. Why: the
  leanest API that can express the DAG lets the whole graph be checked before spend, while code handles the plumbing.
- **D-05** Code nodes are a first-class node type and node I/O is typed. Why: hand-rolled data plumbing was the largest
  source of code in a workflow.
- **D-06** The core is domain-free ([CORE-12](requirements.md#core-graph-and-engine-core)). Its tests run real graphs
  with only code nodes and a fake host node kind. Why: it stays extendable to other domains.
- **D-07** Core config is decoupled from composition config: a composition declares its own typed config, and the core
  passes values through to the owner's validation at compose time ([CFG-02](requirements.md#configuration-cfg)). Why:
  the core should not need to know any composition's settings.
- **D-08** Fan-in is first-class in the IR ([CORE-03](requirements.md#core-graph-and-engine-core)). Why: a renderer can
  draw a composition's graph before it is performed.
- **D-09** The IR is language-neutral and versioned. Why: future authoring languages can feed the same core.
- **D-12** The lifecycle has two stages, **compose** (ending in **pre-flight**, the full validation) and **perform**
  (which starts a **concert**), replacing "launch" and "execution". Why: a hard boundary at which spend begins.
- **D-13** The CLI verbs are `compose` and `perform` ([CLI-01, CLI-02](requirements.md#cli-cli)). Why: the names mirror
  the lifecycle stages, and validation stays usable on its own.
- **D-15** A run is a **concert**; "performance" keeps its plain meaning, execution speed. Why: engineers read it that
  way, and it completes the theme.
- **D-16** Composition params and composed config are plain values during build, so build code may loop, branch and
  compute bounds on them. Node outputs and file contents are Refs. A subcomposition takes plain params and Ref ports. A
  plain value may feed a port, and a Ref never feeds a param. Why: the graph stays a deterministic function of params
  and composed config, and everything else stays checkable before spend.
- **D-17** A composition declares one set of typed params for CLI inputs and tunables alike; the precedence is
  [CFG-04](requirements.md#configuration-cfg) and [architecture 8](architecture.md#8-configuration). Why: one
  declaration instead of separate inputs and config, which keeps D-07.
- **D-18** `parMap` and `parFind` item keys: [SDK-13](requirements.md#sdk-sdk). Why: readable, stable ids in events,
  `ls` and lane refs.
- **D-19** Every composition without ports declares at least one example input set, and one with ports declares none
  ([SDK-01](requirements.md#sdk-sdk), [CLI-01](requirements.md#cli-cli)). `compose` fills the params no YAML layer or
  flag gives from the first example, and an optional param only when they give none of the root's optional params. A
  file param's path in an example resolves against the composition file's directory for a bare file, and the pack's
  directory for a pack's composition, not the cwd. See [Writing a composition](sdk-spec.md#writing-a-composition).
  `perform` never uses examples. Why: `compose` can validate a bare composition file.
- **D-20** Harness adapters are sandboxed subprocesses, not in-process SDKs:
  [ADR 0001](adr/0001-sandboxed-subprocess-adapters.md).
- **D-21** The coding-agent host vocabulary is final: agent node, profile, seat, lane (`fresh`, `fork`, `extend`,
  `read`), target, changeset node, apply node, commits node, harness, check node, sandbox.
- **D-22** A check node is its own host node kind ([HOST-09](requirements.md#coding-agent-host-host)). Why: it runs
  untrusted target commands and needs the sandbox, lane staging, process-tree kill and logs, which trusted in-process
  code nodes provide none of.
- **D-23** The engine stores named additive numbers (metrics) per node instance and sums each name per concert
  ([CORE-19](requirements.md#core-graph-and-engine-core), [HOST-07](requirements.md#coding-agent-host-host)). v1 reports
  token counts only and has no cost or price table. Bounds: [CORE-05](requirements.md#core-graph-and-engine-core) and
  [HOST-08](requirements.md#coding-agent-host-host) set agent limits and a concert's `limits` on time and tokens, and
  compose bounds count node instances plus named counts a host reports, such as agent runs, with caps in the
  [compose README](../packages/core/src/compose/README.md). Why: cost is host policy that v1 does not need, and tokens
  are enough.
- **D-24** An unclaimed config key fails compose only when no installed registrant claims it
  ([CFG-05](requirements.md#configuration-cfg)). Why: typos are caught, and a shared workspace config does not break
  compositions that use only some of its keys.
- **D-25** Maestro targets Linux x64 only, with the sandbox backend behind an interface; arm64 and macOS come later. The
  baseline is [ADR 0003](adr/0003-modern-linux-baseline.md).
- **D-26** Several concerts may run in one workspace with no coordination beyond lane isolation. The record store is one
  SQLite file in WAL mode and the concurrency cap is per concert. Why: it keeps the first version simple.
- **D-27** Cross-concert lanes are forked, read or made into a changeset only, never extended
  ([HOST-13](requirements.md#coding-agent-host-host)). Why: earlier concerts stay immutable and extend-at-most-once
  never needs cross-concert tracking; an encore continues sessions, not lanes.
- **D-29** CLI details that `--help` does not show: `compose --out <file>` saves the IR; `compose` prints diagnostics
  and a one-line plan summary by default, with `--graph` and `--plan` for more; `perform` tells a composition from an IR
  file by extension, and resume is `resume <concert id>` ([CLI-01, CLI-02, CLI-07](requirements.md#cli-cli)).
- **D-30** A pack is a pre-bundled directory, not an npm package: [ADR 0002](adr/0002-pack-bundles.md)
  ([PACK-01](requirements.md#packs-and-distribution-pack-dist)).
- **D-31** Distribution is internal: package names are workspace names (`@maestro/*`, with `maestro-ai` as the
  fallback), the license is `UNLICENSED` and the binary is `maestro`
  ([DIST-05](requirements.md#packs-and-distribution-pack-dist)). Why: licensing is decided later.
- **D-33** A secret param type is out of v1, and secrets are never params; a design where the host resolves secret
  handles at perform time is deferred. Why: YAGNI.
- **D-34** Maestro targets modern Linux x64, and RHEL 8 is best-effort: [ADR 0003](adr/0003-modern-linux-baseline.md).
- **D-35** Starting a concert from an earlier concert's results is deferred: [ADR 0015](adr/0015-concert-fork.md).

## Rulings

### Resume

- **R-01 Resume runs under the config as it stands.** `resume` re-runs pre-flight under the current config and hosts,
  then performs the stored IR with its code hashes recomputed. The record keeps `--preset` and `-c` as typed, and a
  resume reapplies them over the config files as they stand. The resume key holds no config beyond a host node's own, so
  a changed profile or preset alone reruns no `ok` instance. Why: the IR is the build's snapshot, and config resolved at
  perform and code pinned by hash are its intended edges. Applies in `cli`'s `prepare` module (`resumable`) and `core`'s
  perform `resume` module.

### Profiles

- **R-02 The command line has the last word on a profile.** Why: the person running the concert answers for the spend.
  The per-field order is [AT-06](requirements.md#agent-tool-at); the ladder is in
  [architecture 8](architecture.md#8-configuration). Applies to profile resolution in `host-repo`'s profile module
  (`packages/host-repo/src/profile/index.ts`).
- **R-03 `profiles."*"` reaches the seats a preset does not name.** A layer's `"*"` entry applies to every profile it
  does not name, beneath its named entries, so `--preset stub` always means no spend even for a seat the preset never
  lists. The stub needs no `model`, and is not held to a context window it lacks.

### IR files

- **R-04 Hand-written IR proves IR-01 through the golden fixtures.** It runs when it is correct. No effort goes to edge
  cases that only hand-written IR can express. The loader still refuses an IR-file module that imports anything but
  builtins and `@maestro/sdk`, since the same check guards pack entries. Applies to `ir`'s fixtures and `cli`'s `loader`
  module.

### CLI

- **R-05 `config` prints values as they are, secrets included.** It writes to the operator's own stdout, not to a log or
  the record. Masking waits for secret handling (D-33). Applies in `cli`'s `compose` module.
- **R-06 Each command reads and writes one record store**, the one `dataRoot` resolves to. `ls` has no `--all`, because
  listing other stores needs workspace discovery, which maestro does not do. A host-specific `ls` column, such as a
  target, would come through the host's hooks, never from `cli`.
- **R-07 A pack listed under `packs:` wins over an installed pack of the same id**, on every command that loads packs.
  Why: the operator named it on purpose, and an installed copy of an older release must not shadow a pack under
  development. Two installed packs of one id are still refused. Applies in `cli`'s `config` module (`packDirs`).
- **R-09 A command that only reads shows what it can; one that spends or writes refuses on any gap.** A reading view,
  such as `compose --graph`, `config` or `agent show`, shows a gap in place (an `unset` row, a `-`) or reports it on
  stderr. `config` shows only an unset required param, and `agent` the gaps of its profile; both exit 0. `compose`
  previews the pre-flight `perform` runs, so it prints its view, then the gaps on stderr, and exits non-zero on an
  error-severity gap ([CLI-01](requirements.md#cli-cli)). `perform`, `resume`, `encore` and `changeset apply` keep
  refusing before they start. Why: a view is how the operator finds a gap, so refusing it hides the very thing they came
  to see.
- **R-10 `cli` speaks a host's words only where it wires the built-in hosts and in their commands.** Its `hosts` module
  wires them, and `agent` and `changeset` are the repo host's commands. What a host's view holds, such as a profile's
  sections, is the host package's to say, and `cli` renders it as `HostText` is rendered. The rest of `cli` is
  domain-free, but for its own tests and fixtures, which drive a host
  ([CORE-12](requirements.md#core-graph-and-engine-core)). Why: there is one host, and a `Host` hook for commands would
  add a core contract no second host uses yet.

### Agents

- **R-08 An agent gets a named tool list, never a harness's defaults.** claude runs with `Bash`, `Read`, `Write`, `Edit`
  and pi with `read`, `bash`, `edit`, `write`; no profile adds tools until one needs them. Why: a harness's defaults
  change between releases, and claude 2.1.318's include tools that spawn subagents, schedule work past the concert or
  reach other sessions. Applies in each adapter's baseline ([AT-01](requirements.md#agent-tool-at)).
