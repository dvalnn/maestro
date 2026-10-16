# maestro: initial port plan

Status: draft 2, 2026-10-14. Slices, order, acceptance and verification for the initial port defined by D-10 in
`requirements.md`. Written so each slice can be handed to an independent working session. Internals are left to the
session. No schedule or effort estimates are given. Sizes are relative (S, M, L, XL).

## 1. Ground rules for every session

1. **Read first.** `requirements.md`, `architecture.md`, `sdk-spec.md` and this plan. `GLOSSARY.md` is authoritative for
   terms.
2. **Clean break (D-02).** Do not mirror sssf's modules, flags, file formats or vocabulary. The legacy system answers
   "what should this behavior be" and nothing else (`requirements.md` section 12).
3. **Domain-free core (CORE-12).** No domain words in `ir`, `core`, `sdk`, `testkit` or `cli`. The check runs in tests.
4. **Lean (NFR-09).** A new node kind, edge kind or SDK primitive needs a written justification in the slice report. The
   default is a code node or a stdlib helper.
5. **Do not guess.** A question the docs settle is derived and listed in the slice report; a real fork, a contract, a
   removal or a conflict goes to the project owner (`docs/agents/implementation-loop.md`, "Owner calls"). A decision
   with lasting weight goes into a new ADR under `docs/adr/` with the reason and the alternative rejected.
6. **Evidence.** A slice is done when its acceptance items pass, shown by command output in the slice report. A claim
   without output is not evidence.
7. **Scope.** A session changes its own slice's packages. A needed change to another slice's interface is raised in the
   report and made by the owner of that slice, unless trivial.
8. **IR changes** need an IR version note and updated golden fixtures (S1).
9. **Bounded rework.** At most two fix rounds per slice. A blocker, or a slice still failing after its second round,
   goes to the project owner.
10. **Slice report.** Done, evidence, deviations from these docs, decisions made, new open questions, follow-ups. Short.

## 2. Repository shape (proposal)

A Bun workspace monorepo. Package names are workspace names under `@maestro/*` and are never published (D-31).

```
packages/
  ir/               schema, version, validators, golden fixtures
  core/             graph model, compose checks, executor, resume, record, events, config, worker protocol, host interface
  sdk/              authoring API, stdlib
  testkit/          fake host, assertions, stub concert
  cli/              commands, flags, formats, exit codes
  host-agents/      agent and check kinds, lanes, sandbox, harness interface
  host-agents-sdk/  typed constructors and types for the agent host
  harness-<name>/   one adapter each
  pack-general/     the ported compositions (placeholder name)
  render-text/      static graph render (text or Mermaid), live view
docs/               these documents (including adr/), slice reports under reports/
```

## 3. Slices

### S0. Skeleton and spikes (M)

- **Goal.** A working repository and the facts the rest depends on.
- **Deliverables.** Bun workspace, formatting, lint, a test runner, a one-command check. Five spike reports, each with a
  go or no-go (D-32):
  1. A `bun build --compile` binary runs on modern Linux. A RHEL 8 class host run is a compatibility probe (D-34).
  2. `bun:sqlite` in WAL mode works inside the compiled binary: concurrent writers, durability, file location.
  3. The binary loads an external pack bundle (a directory with `maestro-pack.json` and one pre-bundled entry file) and
     calls its code node (D-30).
  4. Bun spawns bubblewrap plus pi (`pi -p --mode json`) and streams the JSON events, including cancel and process-tree
     kill (D-20, R-4).
  5. A binary built on a modern host runs on RHEL 8, as a best-effort probe. Releases build on a modern host (D-34).
- **Acceptance.** Reports exist and the repository's check command passes on an empty skeleton. Spikes 1 to 4 gate the
  port. Spike 5 does not.
- **Depends on.** Nothing.

### S1. IR (M)

- **Goal.** The contract (D-09, CORE-16, IR-01).
- **Deliverables.** The IR as a JSON Schema, version and compatibility policy, validators, a documented description,
  golden fixtures including hand-written IR files that exercise every node kind, edge kind and group.
- **Acceptance.** Validators accept the fixtures and reject malformed variants. An unknown major version is rejected
  with a clear error. A hand-written fan-out, fan-in and loop IR is parseable by an independent reader.
- **Depends on.** S0.

### S2. SDK: build phase (L)

- **Goal.** The authoring API of `sdk-spec.md` sections 2 to 11.
- **Deliverables.** Composition and subcomposition declaration, node constructors (`code`, `map`, `seq`, `repeat`,
  `assert`, `use`), guards and tolerance, Refs with misuse diagnostics, types and schemas, `tpl`, lifting combinators,
  params and ports with example input sets (D-16, D-17, D-19), map item keys (SDK-13), frozen ambient state during build
  (SDK-11), the optional double-build hash comparison (SDK-12), derived metadata, stdlib reducers. Emits IR.
- **Acceptance.** Build tests for every constructor. Byte-stable IR for identical params and composed config. A Ref used
  as a value, or fed to a param, fails with the documented diagnostic. Duplicate item keys fail. Composition metadata
  derives from the graph.
- **Depends on.** S1.
- **Parallel with.** S3, S4.

### S3. Compose and plan (L)

- **Goal.** CORE-07 and the plan output.
- **Deliverables.** IR validation, edge and template type checks, config resolution against owners' schemas,
  bounded-group expansion, host hook plumbing, bounds on node instances and agent runs (D-23), diagnostics with stable
  codes, the plan in JSON and text, and the static graph render (CORE-03, D-08).
- **Acceptance.** On hand-written IR and on SDK-built graphs with the fake host: exact node-instance count where known
  and "up to N" otherwise, a policy violation caught before any run, a config key no installed registrant claims
  rejected (D-24), and a render that shows fan-out, fan-in, loop bounds and guards (AC-2 and AC-5 in part).
- **Depends on.** S1. Uses S2 output when available, hand-written IR before that.
- **Parallel with.** S2, S4.

### S4. Executor, record and events (L)

- **Goal.** CORE-08, CORE-10, CORE-11.
- **Deliverables.** Scheduler, outcome propagation and tolerance, groups, guards, cancellation, the result rule, an
  in-process TypeScript worker and the worker protocol definition, the record store, the event stream.
- **Acceptance.** With a stub host: reject-then-accept, fan-in with settled members, escalation (`seq`), `repeat` to its
  bound, cancellation settling `failed`, and the result rule. Events carry node id and expansion path. The record
  answers the CLI queries. Metrics (CORE-19) are summed per concert and exposed by name, with no meaning attached.
- **Depends on.** S1.
- **Parallel with.** S2, S3.

### S5. Resume (M)

- **Goal.** CORE-09.
- **Deliverables.** The resume key, node-granularity resume.
- **Acceptance.** A killed concert resumes without repeating an `ok` node, agent nodes included. A changed input or code
  hash reruns exactly the affected node and the dependents whose inputs changed (AC-3 in part).
- **Depends on.** S4.

### S6. Config and CLI (L)

- **Goal.** CFG and CLI requirements, against the fake host.
- **Deliverables.** Layered YAML config with namespaces, ownership and provenance, flag derivation from param
  declarations, the commands `compose`, `perform` (including `--resume`), `ls`, `wait`, `kill`, `config` and `prune`
  with their built-in short aliases (D-12 to D-15, D-29), JSON output, documented exit codes.
- **Acceptance.** AC-6 with the fake host. Config precedence and provenance tested. A typo'd key gives a did-you-mean
  diagnostic.
- **Depends on.** S3 and S4.

### S7. Core gate (S)

- **Goal.** Freeze the core's interface before the host builds on it.
- **Deliverables.** The CORE-12 test and an import-graph check, the test kit complete (SDK-08), an API review of `core`,
  `sdk` and the host interface against `architecture.md` section 6, and the host interface documented.
- **Acceptance.** AC-1 and AC-8. A written go from the project owner.
- **Depends on.** S2 to S6.

### S8. Coding-agent host (XL, split)

Sub-slices S8a to S8c can start after S0 as standalone libraries, in parallel with the core slices, because they do not
need the core. S8d and S8e need S7.

- **S8a. Lanes and changesets (L).** Isolated working copies of a target, version handles, `fresh`, `fork`, `join`, the
  join-at-most-once rule, the changeset, and the guarantee that the target's checkout is untouched (HOST-02, HOST-03).
  Lane refs for forking a lane left by an earlier concert, with no cross-concert join (D-27, HOST-13), and `prune` for
  lanes. Consult the behavioral reference for worktree handling, series delivery and what to do with rejected output.
- **S8b. Sandbox and process supervision (M).** Bubblewrap mount plans, read-only binds, writable lane only, secrets
  handling, process-tree kill (HOST-04, HOST-10). Consult the behavioral reference for the mount plan.
- **S8c. Harness interface and stub harness (M).** The adapter interface, a scripted stub harness, prompt staging
  without argument-length limits, token usage reported as metrics (HOST-05, HOST-06, HOST-07).
- **S8d. First real adapter (M).** pi as a sandboxed subprocess over its JSON event stream, using spike 4's findings
  (D-20). Claude Code is the second adapter.
- **S8e. Host kinds, SDK and hooks (L).** `agent` and `check` node kinds (D-22), `host-agents-sdk`, `validate` and
  `bounds` hooks, host config namespaces (HOST-01, HOST-09, HOST-11, HOST-12). Vocabulary per D-21.
- **Acceptance (whole slice).** AC-4 and the host parts of AC-2. The lane double-join diagnostic and a model-family
  policy assertion fire in compose with no spend.

### S9. Pack: ported compositions (L)

- **Goal.** Prove the design on real shapes.
- **Deliverables.** A general pack with the repair-until-green subcomposition, the build-then-repair composition, the
  lens, skeptic and consolidator verification shape, with prompts, schemas and code nodes. At least one domain-flavored
  code node to exercise code nodes in a real pack. Packs load as external bundles listed in workspace config (D-30).
- **Acceptance.** AC-2, AC-3, AC-4 and AC-5 on these compositions, and AC-9: tasks T1 (fixable, accepted after at most
  one repair) and T2 (unfixable by construction, rejected after exactly `maxRepairs` repairs) compared with the
  predecessor on the sequence of agent and check runs by kind, the outcome class, the files touched and a clean target
  checkout (D-28).
- **Depends on.** S2, S7, S8.

### S10. Live view (S, optional)

- **Goal.** CLI-05.
- **Deliverables.** `watch`: the graph with node-instance state overlaid from events.
- **Acceptance.** Shows a running toy concert. Depends only on the event stream.
- **Depends on.** S4, S3.

### S11. Distribution (M)

- **Goal.** DIST-01 to DIST-04, AC-7.
- **Deliverables.** The single executable if S0's spikes were a go, otherwise the package install path. Install and
  upgrade notes. Release setup on the private forge: the binary and package tarballs, license `UNLICENSED` (D-31). The
  release build host is a modern host (D-34).
- **Acceptance.** AC-7 on a modern Linux host.
- **Depends on.** S9.

## 4. Order and parallelism

```
S0 ──> S1 ──┬──> S2 ──┐
            ├──> S3 ──┼──> S6 ──> S7 ──> S8d/S8e ──> S9 ──> S11
            └──> S4 ──┴──> S5 ───┘                    ▲
S0 ──> S8a, S8b, S8c (standalone libraries) ──────────┘
                                          S10 after S3, S4 (optional)
```

Suggested waves:

1. S0.
2. S1, with S8a to S8c starting in parallel.
3. S2, S3, S4 in parallel.
4. S5 and S6.
5. S7.
6. S8d and S8e.
7. S9.
8. S10 and S11.

## 5. Verification strategy

- **Core without a host.** Every core slice is tested with code nodes and the fake host kind only. This is the proof of
  D-06.
- **Host without agents.** The host slices run against the stub harness and a toy target repository. A real harness is
  exercised only in S8d and S9.
- **Fixtures.** Golden IR files (S1), plan snapshots (S3), concert scenarios with scripted outcomes (S4, S5).
- **Reference use.** For behavior questions: lane and worktree semantics, the sandbox mount plan, adapter event streams,
  quality checks. Semantic comparison only (D-28).
- **Adversarial review.** Each slice's report is reviewed against its acceptance items by someone other than the author,
  preferably a different model family where agents author the code.
- **Spend reporting.** Each slice report states what the session spent.

## 6. Slice brief template

```
Slice:        S<n> <name>
Goal:         <one sentence>
Read:         requirements.md, architecture.md, sdk-spec.md, port-plan.md, CODING_STANDARDS.md, docs/adr/,
              prior slice reports
Deliverables: <list from the plan>
Acceptance:   <IDs from requirements.md and the plan>
Constraints:  clean break, no domain words in core, lean primitives, no guessing on open questions
Reference:      <behaviors to consult, if any>
Open Qs:      <open questions that must be ruled before starting; ask if not ruled>
Report:       done, evidence, deviations, decisions, new open questions, follow-ups, spend
```

## 7. After the initial port (not planned here)

Second harness adapter (Claude Code), more compositions from the predecessor, `watch` polish, a richer renderer, SDKs in
other languages, out-of-process workers, macOS, delivery and apply tooling for changesets.

## 8. Decisions each slice relies on

No open question blocks a slice. `requirements.md` section 9 maps every earlier question to its decision.

| Slice | Read these decisions first                             |
| ----- | ------------------------------------------------------ |
| S0    | D-20, D-25, D-30, D-32, D-34                           |
| S2    | D-16 (build-time values), D-17 (params), D-18, D-19    |
| S3    | D-23 (bounds), D-24 (unclaimed keys)                   |
| S4    | D-23 (metrics), D-26 (concurrent concerts, SQLite WAL) |
| S6    | D-12 to D-15, D-17, D-29                               |
| S8a   | D-27 (lane refs)                                       |
| S8b   | D-25 (platform, pluggable sandbox)                     |
| S8d   | D-20 (adapters)                                        |
| S8e   | D-21 (vocabulary), D-22 (check node)                   |
| S9    | D-28 (acceptance comparison), D-30 (packs)             |
| S11   | D-31 (distribution), D-34 (modern Linux baseline)      |
