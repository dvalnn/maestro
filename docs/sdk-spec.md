# maestro: SDK specification

For a composition author, and for whoever implements a host SDK: what you write, and what you can rely on. Terms and
requirement ids are in [requirements](requirements.md); system structure is in [architecture](architecture.md). Type
signatures are in TSDoc.

## Principles

The SDK is the only thing an author learns. It builds a graph (CORE-06) and nothing else.

1. **Lean.** A small set of constructors, each added with a written justification (NFR-09). The default answer to
   "should the SDK have X" is "that is a code node or a stdlib helper".
2. **Symbolic over results.** While building, a node's output is a Ref, never a value. Whatever can be known before any
   spend is checked before any spend.
3. **Typed edges.** Every port has a schema. Nodes connect by typed ports and by lifting combinators (see
   [Refs and mapping between nodes](#refs-and-mapping-between-nodes)), never by untyped dictionaries.
4. **Code where code is honest.** Structure is in the graph. Parsing, merging, regrouping and policy that need real code
   are code nodes.
5. **Domain-free.** The core SDK knows no host. Host SDKs add node constructors and types on top.
6. **Author API alone at the root.** `@maestro/sdk` exports what an author writes. The engine's loader uses the
   `@maestro/sdk/loader` and `@maestro/sdk/stdlib` subpaths, and host SDKs wrap `hostNode` from `@maestro/sdk/host`. The
   packages are in [architecture: Layers and packages](architecture.md#3-layers-and-packages).

## Writing a composition

A **composition** has:

- a name (a pack-scoped id) and a doc string,
- **params** with defaults and CLI hints: one declaration for CLI inputs and tunables (D-17),
- at least one **example input set**, unless it declares ports,
- a **build function** `(params, ports)` that returns the composition's result; without ports it is `(params)`.

The build function runs once per compose, as the first step of the stage, and is a pure function of params and composed
config. An example set serves `compose` only: it gives the params that no YAML layer or flag gives, an optional param's
only when they give none of the root's optional params, and `perform` never uses it (D-19). A file param's path in an
example set resolves against the composition file's directory for a bare file, and the pack's directory for a pack's
composition, so a sample file ships beside it.

A **subcomposition** is a composition that also declares typed **ports**. One constructor declares both. Params are
plain values known at build time; ports are Ref-typed arguments fed by upstream node outputs (D-16), so a composition
with ports runs only through `use` and declares no examples.

### File rules

- One file, one exported composition, named `<stem>.<name>`. The stem is the pack id: lower case, starting with a
  letter, then letters, digits, `_` or `-`, and no installed pack's id.
- A bare file takes its params from flags, its example set and defaults: no config key reaches it. To configure it, make
  it a pack.
- A file imports `@maestro/sdk`, `@maestro/host-repo-sdk`, `node:` builtins and relative files. The binary resolves the
  two SDK imports to its own copies, so there is no install step.
- A prompt longer than a line is a Markdown file beside the composition, by
  [Prompts](../packages/host-repo/README.md#prompts).
- A composition with several prompt texts keeps one `TASKS` table near its top: each call's task file, then the
  fragments it rules by. A fragment joins as a whole paragraph, never spliced into a sentence. `fill(text, values)` from
  `@maestro/classics` replaces each `{name}` with a one-line value and throws on a `{name}` without a value or a value
  without a `{name}`. A branch on a flag stays TypeScript choosing which files to join.
- A code node's function is exported by the composition file itself, or compose refuses it with `SCOPE.export`. A
  function from a relative file is re-exported: `import { tally } from "./lib/util"; export { tally };`.

## Types

Every port, param and config value has a schema that serializes to JSON Schema (CORE-02). The SDK chooses the schema
library. The vocabulary:

- **Values.** `Text`, `Bool`, `Int`, `Float`, `Json(schema)`, `List(T)`, `Struct(fields)` and enumerations. An optional
  value is a record field left out of `required`.
- **Artifacts.** `File`, `Dir` and typed files such as `JsonFile(T)` and `Markdown`. An artifact has provenance and a
  content hash, and is staged by whichever node needs it (CORE-15). Large payloads are always artifacts. An artifact
  param takes a description and no default. A root `File`, `Markdown` or `JsonFile` param takes a file path, and its
  build-time value is the `ArtifactRef` of a copy that perform stages into the concert's artifact area, so build code
  sees the reference, never the content, and the IR holds it as a literal. A `Dir` param is refused.
- **Outcome and Settled.** `Outcome` and `Settled(T)`, the value a group member produces, are SDK exports, the second as
  a type constructor. Their shapes are in [IR: Outcomes and Settled](../packages/ir/README.md#outcomes-and-settled).
- **Host types.** Registered by a host, such as a lane handle. Core treats them as opaque, named and serializable.
  Artifacts and host types are named in schemas by `x-maestro-type` (ADR 0007).

A dependent never reads a skipped node's outputs, since it is skipped too (CORE-04), so a guarded output needs no
default. `ref.or(default)` gives one where a value must flow on.

Refs: ADR 0006.

## Nodes and their results

Every node constructor returns a **Result handle**: a record of Refs with

- the status ports `ok` and `reason` (text, present when rejected or failed),
- one port per declared output, under `out`,
- any ports its kind adds, such as a lane on a host kind.

Every node takes the options `label`, `when` and `tolerate`.

### Node constructors

| Constructor                             | Does                                      | Result                 |
| --------------------------------------- | ----------------------------------------- | ---------------------- |
| `code(fn, opts)`                        | Runs the author's function.               | outputs per `out`      |
| `iter.parMap(items, body, opts)`        | One `body` per item, at once.             | `Settled(M)[]`         |
| `iter.map(items, body, opts)`           | One `body` per item, in order.            | `Settled(M)[]`         |
| `iter.find(items, body, cond, opts)`    | In order, up to the first to meet `cond`. | the one meeting `cond` |
| `iter.parFind(items, body, cond, opts)` | At once; the first to meet `cond` wins.   | the winner             |
| `iter.fold(items, opts)`                | Folds the items, in order.                | the last accumulator   |
| `loop.while(cond, opts)`                | Tests the state before each step.         | the last state         |
| `loop.doWhile(cond, opts)`              | Tests each step's result.                 | the last state         |
| `assert(cond, message, opts?)`          | A policy or an invariant.                 | none, or a handle      |
| `use(sub, ports, opts)`                 | Instantiates a subcomposition.            | its declared outputs   |

What each does when it runs is in [architecture: Execution model](architecture.md#7-execution-model); the fields of a
group in the IR are in [IR: Groups](../packages/ir/README.md#groups). What an author writes:

- **Groups.** `items` is a build-time list or a Ref. The types require `max` over a Ref and refuse it over a written
  list, and compose reports "up to N" for every group but a `parMap` over a written list. A list of unknown length comes
  from a code node (D-16). `M`, a member's value, is the outputs of the body's result, or a record of them by result
  name when the body returns several.
- **`iter.parMap`, `iter.map`.** `onError` is required: `"continue"` or `"stop"`. Give `parMap` and `parFind` a `key`
  function `(item) => key` when items are records or paths, so instance ids stay short and survive reordering. The key
  alphabet is in [IR: Expansion paths](../packages/ir/README.md#expansion-paths).
- **`iter.find`, `iter.parFind`.** `cond` takes a member's result and returns a `Ref<Bool>`. With none meeting it, they
  end on the last member, the last to settle for `parFind`. A `find` over no items settles `skipped`.
- **`iter.fold`.** `first(item)` builds the first accumulator from the first item, and `step(acc, item, i)` each next
  one. The accumulator is a Result handle, and `step` repeats `first`'s outputs. A node's id takes the phase after the
  fold's, `fold/first/merge` or `fold/step/merge`, so a helper called in both needs no label.
- **`loop`.** `init` is the first state, `step(state, i)` builds the next, and `max` is a literal or a param, so it is
  known at compose time. The state is a Result handle, the previous node's outputs with its `ok` and `reason`, so
  `loop.while((s) => not(s.ok), ...)` repairs while a check is red.
  - `loop.while` tests the state before each step and may run none. Its `cond` is a Bool port of the state, such as
    `s.ok`, or of a node built from the state, not from the step. The plan shows `0 to max` steps.
  - `loop.doWhile` tests each step's result, so one step runs at least. The plan shows `1 to max`.
- **State.** A loop or fold carries one node's outputs, so state of several values comes from one node, usually the
  step's last, that takes the others in and passes them out. A reviser loop's state is its scorer, with outputs `draft`
  and `good`: `loop.while((s) => not(s.out.good), ...)`. A state port named `ok`, `reason` or `index` (a fold's also
  `item`) is a build error.
- **`assert`.** A plain condition is checked at build, where a failure is an `ASSERT` error and `onFail` is not taken. A
  `Ref<Bool>` condition makes a node that settles `onFail`, `rejected` or `failed`, when false. It returns its handle,
  so a node can wait on it (`when: holds.ok`) and the result rule finds it as a cause.
- **`use`.** `ports` are Refs or plain values, and `Optional` ports may be left out. `opts.params` sets the
  subcomposition's params for this instance.

Refs: CORE-05, D-18, SDK-13, ADR 0006, ADR 0009.

### Guards and tolerance

- **`when: Ref<Bool>`** on any node. A false guard makes the node `skipped`.
- **`tolerate: "rejected"`** on a consumer lets it run after a `rejected` upstream whose declared outputs it reads. On a
  `loop` or an `iter.fold` it carries a `rejected` state or accumulator, `init`'s or `first`'s included, into the next
  step; without it the group ends on that one. `failed` and `skipped` are never tolerable.

What a consumer does after each upstream outcome is in
[architecture: Execution model](architecture.md#7-execution-model).

### Result of a composition

A build function returns a Result handle or a Ref to a node's port; a subcomposition's may return an object of named
outputs for `use`, and a root build that returns no node is `TYPE.result`. The concert result and its exit-code category
follow from the returned node by the result rule (CORE-04), in
[architecture: Execution model](architecture.md#7-execution-model).

## Refs and mapping between nodes

A **Ref** is a symbolic handle to a typed value that will exist at perform time.

- **No branching.** A Ref where a plain value is required (`if (ref)`, string concatenation, indexing by a Ref) throws a
  build diagnostic that names the lifting alternative. This keeps the graph decidable (D-04).
- **Lifting combinators** build a new Ref from a Ref, each as a visible node, never a hidden one:
  - `ref.get(path)` selects a field by a dotted path, typed by the path. The type checks paths of up to 8 fields; a
    longer path does not compile.
  - `when(cond, value)` and `ref.or(default)` for guards and defaults. `or` gives the default when its node settled
    `rejected` or `skipped`, and fails when it failed, as `firstOk` does (ADR 0006).
  - `lookup(table, key)` indexes a plain table by a Ref key.
  - `not(ref)` negates a `Ref<Bool>`.

  A lift's id names its source node and what it does, so it needs no label: `review.out.result.get("summary")` is
  `review_summary`, `x.or(d)` is `x_or`, `not(x.ok)` is `x_not`, and `readJson(planner.out.plan)` is
  `planner_plan_json`, so two JSON outputs of one node need no labels. Every lift also takes `label` for the rare clash.

- **Mapping between ports** is by typed assignment. A mismatch is a compose-time type error (CORE-02) naming both ports
  and schemas.
- **Known at build (D-16).** Params and composed config are plain values; node outputs and file contents are Refs. A
  plain value may feed a port, and a Ref never feeds a param.
- **Build, compose, perform.** Build runs the author's code as compose's first step, on plain values: a build-time `if`
  changes the graph's shape, a Ref is a placeholder and coercing it throws, and ambient state (environment, clock,
  randomness) is frozen (SDK-11). The loader builds twice and compares the IR (SDK-12), byte-stable for identical params
  and composed config (CORE-06). Compose resolves the guards that depend only on known values, and perform settles the
  rest. A `when` guard on a Ref keeps both branches.

## Code nodes

A code node is the SDK's answer to "this needs real code". It runs only at perform, never during build or compose (ADR
0009). Its function is an exported `(inputs, ctx) => outputs`, sync or async, with inputs and outputs keyed by port name
(ADR 0008).

- **Typed in and out.** Schemas are checked against the function's type at compile time; a return that fails its schema
  makes the node `failed`.
- **Timeout.** None unless the author sets `timeout`, in milliseconds or as a duration such as `90s`. A node that runs
  past it settles `failed`.
- **Trusted.** The node reads and writes what its function does. Files it hands on travel by artifact ports, and nothing
  checks other access (RISK-2).
- **Context.** `ctx` offers the concert id, the clock, the instance's scratch directory, `log(line)` and `signal`, plus
  what hosts add (`env`, from the [host interface](architecture.md#6-host-interface); the type is in
  [IR: Code-function contract](../packages/ir/README.md#code-function-contract)). A file written in the scratch
  directory and returned at an artifact output becomes an artifact (ADR 0007). A node that settles `failed` keeps its
  scratch directory, and core logs its path.
- **Cancellation.** `signal` aborts on cancel or timeout. Pass it to `Bun.spawn({ signal })` or `fetch`: a process the
  function spawned without it outlives the node. The worker protocol is in
  [architecture: Workers and code nodes](architecture.md#9-workers-and-code-nodes).
- **Errors.** A thrown error settles the node `failed`. `reject(reason, outputs?)` settles it `rejected`, with its
  outputs when given, checked like an `ok` node's.
- **Runtime.** A worker reference names the runtime. The initial runtime is `ts`, in-process (CORE-14).

## Subcompositions

- **Scope.** Each use produces a named scope in the IR with the subcomposition's id. Renderers can collapse it, and
  diagnostics name it.
- **Reuse.** A pack that uses another's subcomposition imports its source, and its bundle includes it (ADR 0002, ADR
  0008).
- **Params.** A subcomposition owns its params. The use site sets them for that instance and wins over every other layer
  (D-17).
- **Optional ports.** A port declared `Optional(type)` may be left out of a `use` feed, or fed `undefined`. Its entry in
  the body's ports is then `undefined` at build time, so the body skips what depends on it, and no node or edge is added
  for it. A missing required port, a required port fed `undefined` and an undeclared key are `TYPE.ports`.

## Params and the CLI

- A param declaration is the single source for a composition's CLI flags (SDK-01) and its tunables. Schemas carry hints:
  short description, repeatable, required, default. A param's flag is its name in kebab-case.
- Params live in config under the id of the pack whose bundle holds the composition.
- Host types may be param types, the host reading each value from its text. The coding-agent host adds the lane ref,
  written `<concert id>.<node instance id>` (D-27).
- A param declared `Optional(type)` is neither required nor defaulted: its build value is `undefined` when nothing gives
  it, and `rep` shows it as `optional`. A rule across params, such as two of which exactly one is given, is the build's,
  refusing with `CFG.param`.
- The CLI validates params before build. An absent required param, or a constraint violation such as a list of fewer
  than two models for a comparison, is a usage error with a next-step message (CLI-06).

### Config

Params carry defaults declared in code (CFG-03), and composed config reaches the build function. Precedence, layers and
presets are in [architecture: Configuration](architecture.md#8-configuration). Compositions never read engine settings.

Refs: CFG-04, D-17.

## Standard library

Built only from the constructors above (NFR-09), and initially (SDK-07):

- **Reducers.** `firstOk(results)`, `okOnly(results)` and `allSettled(results)`. They are fan-in nodes: they run once
  every input has settled and receive each as `Settled` (ADR 0006). They take a `parMap` or `map` handle or a list of
  outputs. `firstOk` returns its Result handle and, with no `ok` input, settles `failed` if any input failed, else
  `rejected`. `okOnly` and `allSettled` return a Ref to their list.
- **Readers.** `readJson(file)` reads a `JsonFile(T)` artifact, such as an agent's `JsonOut`, into a `Ref<T>` checked
  against its schema. It rejects with the reason when the file is not JSON or misses the schema.
- **Logic.** `not(ref)`, a lift, for a loop condition such as `not(state.ok)`.

## Host SDK contract

A host SDK is a package that exports typed constructors and types for its host's node kinds. It must:

1. Produce the same Result handle shape as core constructors.
2. Declare each constructor's ports with schemas, including ports whose schema depends on the node's configuration.
3. Contribute host types, such as a lane handle, with serialization into the IR.
4. Provide builders for host-specific references (`fresh`, `fork`, `extend`) that return typed handles, never raw
   strings.
5. Register its compose-time `validate` and `bounds` hooks with the core through the
   [host interface](architecture.md#6-host-interface).
6. Contribute param types and their CLI resolution.

Its constructors wrap `hostNode(kind, opts)` from `@maestro/sdk/host`, which emits a node of a host kind.
`literal(value, type)` from `@maestro/sdk` makes a plain value an input of a declared type, so a param read from its
text can feed a host node's port of that type.

### Repo host SDK

`@maestro/host-repo-sdk` builds the [repo host's](../packages/host-repo/README.md) nodes. It imports only the SDK and
the IR, since packs bundle it. Lanes and their versions are in [Lanes](../packages/host-repo/README.md#lanes).

| Export                                     | Gives                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `Lane`                                     | the `repo.lane` type of a lane version, and the lane ref param type   |
| `fresh(base?)`                             | a new lane                                                            |
| `fork(v)`, `read(v)`                       | a copy of version `v`, or `v` with its writes discarded[^lane]        |
| `extend(v)`                                | the lane continued from `v`, a lane output of this concert            |
| `Session`                                  | the `repo.session` type of an agent's harness session                 |
| `JsonOut(file, type)`, `MarkdownOut(file)` | an agent output: a file in its outbox, arriving as an artifact        |
| `seat(name, opts)`                         | a function that emits a `repo.agent` node running a profile[^seat]    |
| `check(lane, which?)`                      | a `repo.check` node[^check]                                           |
| `changeset(v)`                             | a `repo.changeset` node: version `v` as a patch series                |
| `commits(revs)`                            | a `repo.commits` node: the target commits `revs` names, as a version  |
| `apply(lane, changeset, opts)`             | a `repo.apply` node: one changeset, `opts.strategy` `3way` or `clean` |

[^lane]: `v` is a lane output or a lane ref, which becomes a `literal` of type `Lane`.

[^seat]:
    `seat(name, { profile?, verdict?, encore?, out?, checks? })`. `profile` is a bare name or `<pack>/<name>`, by
    default the seat's own name ([Profiles and prompts](../packages/host-repo/README.md#profiles-and-prompts)).
    `verdict: true` marks a verdict agent, which may reject ([Agent node](../packages/host-repo/README.md#agent-node));
    `encore: false` starts its agents fresh in an encore. A call takes `task`, `lane`, the common options, and may add
    `session` (an agent's `out.session`, which it continues), `attachments` (each `{ artifact, hint }`), outputs and
    checks. Outputs add with the call winning on a name, checks are a union, and the result's outputs are typed by both:
    `report`, `staged`, `session`, `lane` unless it reads, and each declared output. An attachment named `prompt`,
    `lane` or `session`, or an output named `lane`, `report`, `staged` or `session`, is a build error; an attachment
    named `previous` is refused by the host's `validate` at compose.

[^check]:
    `which` is every named check, the one named, or an inline `{ run, timeout, ... }`. Outputs: `logs`, `output` (the
    check's `$MAESTRO_CHECK_OUTPUT` directory) and `lane` unless it reads.

N lanes merge by folding `apply` over their changesets with `iter.fold`, a resolver agent extending on conflict (the
`fold` fixture below).

## Diagnostics catalogue

Stable code prefixes (CORE-17). Every diagnostic carries node id, scope, source location, message and a suggested next
step. Severity is `error` or `warning`, and any error stops before any concert starts (NFR-02).

- `IR` schema violation, unknown version.
- `REF` a Ref used where a value is required, a Ref that escaped its scope.
- `TYPE` edge schema mismatch, a build that returns no node, a `readJson` of an artifact that is not a JSON file.
- `BOUND` a group without a bound, a bound over a configured cap on node instances or on a host's named count, a code
  node `timeout` that is neither a duration nor a whole number of milliseconds within the timer range (`BOUND.timeout`).
- `CFG` unclaimed key, schema violation, required key missing, examples missing or given with ports, params a build
  refuses together (`CFG.param`).
- `HOST` anything a host `validate` hook reports, such as a lane extended twice.
- `BUILD` an ambient read during build (SDK-11), or a build that yields different IR twice (SDK-12).
- `ASSERT` an `assert` that fails at build.
- `SCOPE` duplicate ids (two unlabelled nodes deriving one id need a `label`), duplicate `parMap` or `parFind` item
  keys, an unresolved subcomposition, a code node function that is not exported.

## Test kit

SDK-08. The `@maestro/testkit` package offers:

- A **fake host** with configurable node kinds and scripted outcomes, including reject-then-accept.
- **Graph assertions.** `buildIr` builds a composition, `shapeOf` counts an IR's nodes, kinds and edges, and `composeIr`
  gives the plan's bounds or the diagnostics.
- **Stub concert.** `stubConcert` performs an IR over the real executor with scripted host nodes and stubbed code, for
  outcome propagation and resume tests.

## Worked examples

Build, then repair while the check is red, bounded by the composition's own param. A prompt is a task and attachments:
the task is built in TypeScript from plain values, and a run-time value reaches an agent as an attachment, a code node's
output or the lane it continues.

```ts
const builder = seat("builder", { checks: ["test"] });

export const buildThenRepair = composition(
  "build_then_repair",
  {
    params: {
      task: Text({ default: "Add a greeting to a.txt." }),
      maxRepairs: Int({ default: 2 }),
    },
    examples: [{}],
  },
  ({ task, maxRepairs }) => {
    const built = builder({ label: "build", task, lane: fresh() });
    const repaired = loop.while((checked) => not(checked.ok), {
      init: check(extend(built.out.lane), "test"),
      step: (checked) => {
        const repair = builder({
          label: "repair",
          task: "Make check 'test' pass.",
          lane: extend(checked.out.lane),
          session: built.out.session,
          attachments: {
            logs: {
              artifact: checked.out.logs,
              hint: "Read first, to see why the check failed",
            },
          },
        });
        return check(extend(repair.out.lane), "test");
      },
      max: maxRepairs,
      tolerate: "rejected",
    });
    return changeset(repaired.out.lane, { label: "result" });
  },
);
```

The fixtures hold more, each type-checked and built by the suite:

- `packages/host-repo-sdk/src/fixtures/examples.ts`: `review` (lens, skeptic and consolidator), `buildThenRepair` (shown
  above) and `fold` (N lanes merged).
- `packages/sdk/src/fixtures/examples.ts`, over the fake host: `fixUntilGreen` (the same loop as a subcomposition),
  `escalate` (an `iter.find` over a `models` list that stops at the first `fixUntilGreen` to end green), `fanout` (an
  `iter.parMap` over it, reduced by `firstOk`) and `planPanel` (a `parMap` of plans, then a synthesis that falls back to
  a plan that succeeded).

A model belongs to a profile, so a group item cannot pick one. Escalating over models takes one seat per profile, as in
[architecture: Execution model](architecture.md#7-execution-model) (Groups).

## Out of scope in v1

- SDKs in languages other than TypeScript (the IR allows them).
- An expression language. Code nodes cover it.
- Perform-time-shaped graphs beyond bounded groups. A region's size may depend on a result only with a declared maximum.
- Dynamic subcomposition choice at perform time. A composition may select among subcompositions at build time from
  params.
