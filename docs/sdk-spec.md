# maestro: SDK specification (concept level)

Status: draft 2, 2026-10-14. Defines what the authoring SDK, the IR emission contract, the host SDK contract, the worker
protocol and the test kit must offer, and the semantics an author can rely on. It is not a code-level spec: type
signatures, module layout and wire formats are decided during implementation. Code in section 14 is illustrative and
non-normative.

Terms and requirement IDs are defined in `requirements.md`. System structure is in `architecture.md`.

## 1. Purpose and principles

The SDK is the only thing an author learns. It builds a graph (CORE-06) and nothing else. Its design rules:

1. **Lean.** A small set of constructors. Each addition needs a written justification (NFR-09). The default answer to
   "should the SDK have X" is "that is a code node or a stdlib helper".
2. **Symbolic over results.** While building, a node's output is a Ref, never a value. Everything that can be known
   before any spend is checked before any spend.
3. **Typed edges.** Every port has a schema. Mapping between nodes is by typed ports and lifting combinators, not by
   untyped dictionaries.
4. **Code where code is honest.** Structure is in the graph. Parsing, merging, regrouping and policy that need real code
   are code nodes.
5. **Domain-free.** The core SDK knows no host. Host SDKs add their node constructors and types on top.
6. **Author API alone at the root.** `@maestro/sdk` exports what an author writes. What the engine's loader calls to
   describe, build and bundle compositions (`build`, `buildNamed`, `describe`, `glue`, the build context and the SDK and
   stdlib identity) is the `@maestro/sdk/loader` subpath, and the engine also loads `@maestro/sdk/stdlib`.

## 2. What an author writes

A **composition** has:

- a name (pack-scoped id) and a doc string,
- **params** with defaults and CLI hints: one declaration for CLI inputs and tunables (section 9, D-17),
- at least one **example input set**, so `compose` can validate it without flags (D-19),
- a **build function** `(params, ports)` that returns the composition's result (section 6). Without ports it is
  `(params)`.

A **subcomposition** is a composition that also declares typed **ports**, used inside another composition (section 8).
One constructor declares both. Params are plain values known at build time. Ports are Ref-typed arguments fed by
upstream node outputs (D-16), so a composition with ports runs only through `use`. A shared building block that should
also run alone exports a second composition without ports that uses it with defaults.

The build function runs once per compose, as the first step of the stage. It is a pure function of params and composed
config.

## 3. Types

Every port, param and config value has a schema that serializes to JSON Schema (CORE-02). The SDK chooses the schema
library. The type vocabulary is:

- **Values.** `Text`, `Bool`, `Int`, `Float`, `Json(schema)`, `List(T)`, `Record`, and enumerations.
- **Artifacts.** `File`, `Dir`, and typed files such as `JsonFile(schema)` and `Markdown`. An artifact has provenance
  and a content hash and is staged by whichever node needs it (CORE-15). Artifacts are values only in the sense that
  nodes consume and produce them. Large payloads are always artifacts.
- **Outcome and Settled.** `Outcome` is `ok | rejected | failed | skipped`. `Settled(T)` is what a group member
  produces: `{outcome: ok, value: T}`, `{outcome: rejected | failed, value?: T, reason: Text}` or
  `{outcome: skipped, value?: T, reason?: Text}` (ADR 0006).
- **Host types.** Registered by a host (for example a lane handle). Core treats them as opaque, named, serializable.
  Artifacts and host types are named in their schemas by `x-maestro-type` (ADR 0007).

An optional value is a record field left out of `required`. A dependent never reads a skipped node's outputs, since it
is skipped too (CORE-04), so a guarded output needs no default; `ref.or(default)` gives one where a value must flow on.

## 4. Nodes and their results

Every node constructor returns a **Result handle** with:

- the status ports `ok` and `reason` (text, present when rejected or failed),
- one port per declared output, under `out`,
- any extra ports its kind defines (for a host kind, for example a lane).

All of these are Refs. A node accepts common options: `label`, `when` and `tolerate`.

### 4.1 Core node constructors

| Constructor                             | Purpose                                                                        | Key arguments                                                   | Result                                           |
| --------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------ |
| `code(fn, opts)`                        | Run the author's function over typed inputs.                                   | `in` ports, `out` schema, `reads`, `writes`, `timeout`          | outputs per `out`                                |
| `iter.parMap(items, body, opts)`        | Instantiate `body` once per item, all at once.                                 | `items`, body, `max`, `onError`, `key`                          | `Settled(M)[]` with static cardinality metadata  |
| `iter.map(items, body, opts)`           | Instantiate `body` once per item, in order.                                    | `items`, body, `max`, `onError`                                 | `Settled(M)[]`                                   |
| `iter.find(items, body, cond, opts)`    | Instantiate `body` per item in order, stop at the first result meeting `cond`. | `items`, body, `cond(result)`, `max`                            | the result meeting `cond`, or the last           |
| `iter.parFind(items, body, cond, opts)` | Instantiate `body` once per item, all at once; the first to meet `cond` wins.  | `items`, body, `cond(result)`, `max`, `key`                     | the result meeting `cond`, or the last to settle |
| `iter.fold(items, opts)`                | Fold the items into an accumulator, in order.                                  | `items`, `first(item)`, `step(acc, item, i)`, `max`, `tolerate` | the last accumulator                             |
| `loop.while(cond, opts)`                | Bounded loop carrying typed state, testing the state before each step.         | `cond(state)`, `init`, `step(state, i)`, `max`, `tolerate`      | the last state                                   |
| `loop.doWhile(cond, opts)`              | Bounded loop carrying typed state, testing each step's result.                 | `cond(result)`, `init`, `step(state, i)`, `max`, `tolerate`     | the last state                                   |
| `assert(cond, message)`                 | A policy or invariant.                                                         | a boolean                                                       | none                                             |
| `use(sub, ports, opts)`                 | Instantiate a subcomposition.                                                  | `ports` (Refs or plain values), `opts.params` overrides         | the subcomposition's declared outputs            |

Semantics each constructor must honor:

- **`code`.** Runs only at perform, never during build or compose (ADR 0009). Its function is an exported
  `(inputs, ctx) => outputs`, sync or async, with inputs and outputs keyed by port name (ADR 0008). It can return
  `reject(reason, outputs?)` for a negative verdict, which becomes outcome `rejected`.
- **`iter`.** `items` may be a build-time list or a Ref resolved later. The types require `max` over a Ref and refuse it
  over a written list, which bounds the group itself; compose reports "up to N" for every group but a `parMap` over a
  written list. A list of unknown length comes from a code node and feeds a bounded group (D-16). A member's value `M`
  is the outputs of the body's result, or a record of them by result name when the body returns an object of two or more
  results.
- **`iter.parMap`.** Items are keyed: a primitive item by its value, any other item by index, or by an optional key
  function `(item) => key`. Give a key function whenever items are records or paths, so keys stay short and survive
  reordering. A key is sanitized to `[A-Za-z0-9_.-]`, anything else becoming `_`, and keys that sanitize alike are
  duplicates: a compose error for a build-time list without a key function (D-18, SDK-13), and a failed `parMap` when a
  key function runs, at perform (ADR 0009), or the list is known only at perform time. Keys only name node instances for
  `ls` and lane refs. `onError` is required. With `"continue"` a non-ok member becomes a `Settled` value and the group
  is `ok`. With `"stop"` the group takes the worst member outcome, and the first non-ok member cancels the rest (ADR
  0006).
- **`iter.map`.** As `parMap`, one item at a time in item order, its members keyed by index. With `"stop"` no item
  starts after a non-ok member, and `results` hold the members that ran.
- **`iter.find`.** Covers escalation over an ordered list. `cond` gets a member's result and returns a `Ref<Bool>`.
  Members after one meeting `cond` never start, and the group mirrors its member's outputs. A member, or the node `cond`
  reads, that settles `failed` fails the group. A `find` stays an "up to N" region in the plan. A `find` over no items
  settles `skipped`.
- **`iter.parFind`.** As `find`, with every member started at once and keyed as `parMap` keys them, key function
  included. The first member to settle meeting `cond` is the result, and the others are cancelled as `skipped` with the
  reason `cancelled: <instance> met the condition`. When none meets it, the group ends on the last member to settle.
- **`iter.fold`.** `first` builds the first accumulator from the first item, and `step` each next one from the previous
  accumulator, the item and its index. The accumulator is a Result handle (section 4), as a loop's state is, and the
  step must repeat `first`'s outputs. The nodes `first` builds run on the first item alone, and those `step` builds on
  each next one. Ids take the phase after the fold's (`fold/first/merge`, `fold/step/merge`), so a helper called in both
  needs no label. The fold ends on its last accumulator, or on one it cannot carry on from: a `rejected` one is carried
  only when `tolerate` says so. A fold over no items settles `skipped`. An accumulator port named `ok`, `reason`,
  `index` or `item` is a build error.
- **`loop`.** Two loops, the condition first. Each goes on while its condition, a `Ref<Bool>`, holds:
  - `loop.while` reads the condition on the state before each step, so it may run no step. The condition is a Bool port
    of the state, such as `s.ok`, or of a node made from the state alone. A condition false on `init` ends the loop as
    `init` ended. The plan shows `0 to max` steps.
  - `loop.doWhile` reads the condition on each step's result, so at least one step runs. The plan shows `1 to max`.

  The condition and the step receive the state as a Result handle (section 4): the previous node's outputs, its `ok` and
  its `reason`, so `loop.while((s) => not(s.ok), ...)` repairs while a check is red. The step also receives the
  iteration index. Whatever stops it, its condition or `max`, a loop ends with its last state's outcome, reason and
  outputs. A loop stays an "up to `max`" region in the plan, for bounds and rendering. `max` must be known at compose
  time, from a literal or a param. State edges are tolerant of `rejected` only if `tolerate` says so. A state port named
  `ok`, `reason` or `index` is a build error, since the loop's state holds those names.

- **`assert`.** Evaluated at build if the condition is a plain value, and at perform time otherwise. A failed build-time
  assert is a diagnostic error. A perform-time assert yields a `rejected` or `failed` node, whichever the assert
  declares.
- **`use`.** Creates a scope in the IR (architecture section 5). Params of the subcomposition may be set at the use
  site, which has the highest precedence (D-17).

Host SDKs add constructors with the same Result handle shape (section 12).

### 4.2 Guards and tolerance

- **`when: Ref<Bool>`** on any node. A false guard makes the node `skipped`.
- **Status ports.** A node that reads only an upstream's `ok` or `reason` runs after a `rejected` upstream with no
  `tolerate`, so `not(check.ok)` needs none.
- **`tolerate: "rejected"`** on a consuming node or a `loop` state edge lets the node run after a `rejected` upstream
  whose declared outputs it reads. It then receives the upstream's outputs when it rejected with them. Without either, a
  non-ok upstream makes the node `skipped` (CORE-04). `failed` and `skipped` are never tolerable.
- **Missing outputs.** A declared output a rejection did not carry is never a crash. A node that reads it is `skipped`,
  with that upstream as its cause, so the concert result names the rejection and its reason. A condition that reads it,
  a guard, a `cond` or a loop's, reads not true.

## 5. Refs and mapping between nodes

A **Ref** is a symbolic handle to a typed value that will exist at perform time. Rules:

- **No branching.** Using a Ref where a plain value is required (`if (ref)`, string concatenation, array indexing by a
  Ref) throws a build diagnostic that names the lifting alternative. This is what keeps the graph decidable (D-04).
- **Lifting combinators** (all produce visible nodes in the graph, never hidden ones):
  - `ref.pick(path)` selects a field of a structured value.
  - `zip(a, b, { on? })` pairs the items of two lists, by position or by the key field `on`.
  - `when(cond, ...)` and `ref.or(default)` for guards and defaults.
  - `lookup(table, key)` indexes a plain table by a Ref key.
  - `not(ref)` negates a `Ref<Bool>`.

  A lift's id names its source node and what it does, so it needs no label: `review.out.result.pick("summary")` is
  `review_summary`, `x.or(…)` is `x_or`, and `not(x.ok)` is `x_not`. Every lift also takes `label`, for the rare clash
  that remains.

- **Mapping between ports** is by typed assignment. A mismatch is a compose-time type error (CORE-02) naming both ports
  and schemas.
- **Templates.** `tpl(file, vars)` renders a prompt or text from a template file. The variable set is checked against
  the template's declared variables and against the Refs' schemas at compose time. A missing or mistyped variable is an
  error before spend.
- **Known at build (D-16).** Params and composed config are plain values. Node outputs and file contents are Refs. A
  subcomposition takes plain params and Ref ports. A plain value may feed a port, and a Ref never feeds a param.
- **Three tiers.** Build (plain values, shapes the graph), compose after build (checks, expansion, bounds), perform
  (Refs resolve). A build-time `if` on a plain value changes the graph's shape. A `when` guard on a Ref keeps both
  branches.
- **Enforcement.** Plain and Ref are distinct types. A Ref throws when coerced to a boolean or a string. Ambient state
  (environment, clock, randomness) is frozen during build (SDK-11). The loader builds twice and compares the IR
  (SDK-12).

## 6. Results of a composition

A build function returns a Result handle or a Ref to a node's port; a subcomposition's may return an object of named
outputs for `use`. A root build that returns no node is `TYPE.result`. For an executable composition the **concert
result** follows from the returned node by the **result rule** (CORE-04, architecture 7):

- an `ok` node is the result,
- otherwise the result is the root cause of its outcome, so a skipped consolidator reports the code node that threw.

Returning a reducer such as `firstOk` makes it the result, since the rule never looks past a tolerated input.

The result's outcome gives the CLI its exit-code category: accepted (`ok`), rejected, or failed.

## 7. Code nodes

A code node is the SDK's answer to "this needs real code".

- **Typed in and out.** Input and output schemas are declared, and the function's type is checked against them at
  compile time. Output validation happens at the node boundary. A return that fails its schema makes the node `failed`
  with the validation error.
- **Timeout.** A code node runs with no time limit unless its author sets `timeout` in milliseconds. One that runs past
  it settles `failed`.
- **Declared reads and writes.** File and directory paths a node reads or writes are declared by artifact ports or by
  explicit `reads` and `writes`. Compose can check write scope. Undeclared access is the author's error, and nothing
  detects it (R-2).
- **Context.** A typed, read-only context offers the concert id, the clock value, the instance's own scratch directory
  and `log(line)`, which records a line on the instance, plus whatever the loaded hosts add (architecture section 6). A
  file the node writes there and returns at an artifact output becomes an artifact (ADR 0007).
- **Errors.** A thrown error settles the node as `failed`. `reject(reason, outputs?)` settles it as `rejected`, with its
  outputs when given, checked like an `ok` node's.
- **Runtime.** A worker reference names the runtime. The initial runtime is `ts`, in-process (CORE-14).

## 8. Subcompositions

- **Signature.** Typed params, typed ports and typed outputs (Result handles or named outputs).
- **Scope.** Each use produces a named scope in the IR with the subcomposition's id. Renderers can collapse it, and
  diagnostics name it.
- **Reuse.** Subcompositions are exported by packs and used by other packs. A pack that uses another pack's
  subcomposition imports its source, and the using pack's bundle includes it (ADR 0002, ADR 0008). They replace the `_`
  helper modules of the predecessor.
- **Params.** A subcomposition owns its params. The use site may set them for that instance, and that wins over every
  other layer (D-17).

## 9. Params and the CLI

- A composition's param declaration is the single source for its CLI flags (SDK-01) and its tunables. Schemas carry
  hints: short description, repeatable, required, default. A param's flag is its name in kebab-case.
- A composition's params live in config under the id of the pack whose bundle holds it, so a subcomposition borrowed
  from another pack is configured under the using pack's id, and only if that pack exports it. The schema that checks a
  key is always the one of the code that runs.
- Host types may appear as param types, the host reading each value from its text. The coding-agent host adds the lane
  ref, written `<concert id>.<node instance id>`, for forking or reading a lane left by an earlier concert (D-27).
- The CLI validates params before build. A required param that is absent, or a constraint violation (for example a list
  of fewer than two models for a comparison), is a usage error with a next-step message (CLI-06).
- Every composition declares at least one example input set. `compose` uses the first one, over every YAML layer and
  under the flags, a given flag overriding its own key, and `perform` never does (D-19).
- What a composition needs (plan node kinds, instance counts, host counts) is derived by compose and host `validate`,
  never declared (SDK-06).

## 10. Config

- Params carry defaults declared in code (CFG-03).
- Composed config reaches the build function. Values that bound groups (`max` on a `loop` and on an `iter` group) come
  from params and are therefore known at compose time.
- Precedence, highest first (CFG-04, D-17): the use site for a subcomposition or the CLI flag for a root composition,
  then, for `compose`, the example set, then profile, workspace and user YAML, then the default. YAML keys live under
  the pack id and then the composition id.
- A key that no installed registrant claims fails compose with a did-you-mean hint. A key claimed by an installed but
  unused registrant is ignored (CFG-05, D-24). The composed config view reports value provenance (CFG-06).
- Core config is not visible to compositions. They never read engine settings.

## 11. Standard library

The standard library is built only from the constructors above (NFR-09). Initial contents (SDK-07):

- **Reducers.** `firstOk(results)`, `okOnly(results)` and `settle(results)`. Marked fan-in in the IR, so they run once
  every input has settled and receive each as `Settled` (ADR 0006). They take a `parMap` or `map`'s handle or a list of
  outputs. `firstOk` with no `ok` input settles `failed` if any input failed, else `rejected`.
- **Templating.** `tpl` as above. Prompt files are text artifacts staged by the consuming host node.
- **Readers.** Typed readers for JSON and text artifacts, with schema validation, as code nodes.
- **Logic.** `not(ref)` negates a `Ref<Bool>`, a lift as in section 5, for a loop condition such as `not(state.ok)`.

## 12. Host SDK contract

A host SDK is a package that exports typed constructors and types for the host's node kinds. It must:

1. Produce the same Result handle shape as core constructors (section 4).
2. Declare each constructor's ports with schemas, including ports whose schema depends on the node's configuration.
3. Contribute host types (for example a lane handle) with serialization into the IR.
4. Provide builders for host-specific references (for example `fresh`, `fork`, `join`) that return typed handles, never
   raw strings.
5. Register its compose-time `validate` and `bounds` hooks with the core through the host interface (architecture
   section 6).
6. Contribute param types and their CLI resolution.

A host type works as a param type and a port type alike. `literal(value, type)` from `@maestro/sdk` makes a plain value
an input of a declared type, so a param read from its text can feed a host node's port of that type.

### 12.1 Repo host SDK

`@maestro/host-repo-sdk` builds the repo host's nodes (architecture 12). It imports only the SDK and the IR, since packs
bundle it.

| Export                                     | What it gives                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Lane`                                     | The `repo.lane` type of a lane version, and the lane ref param type                                                                     |
| `fresh(base?)`                             | A new lane cut at `base`, else `target.base`, else the target's `HEAD`                                                                  |
| `fork(v)`, `read(v)`                       | A copy of version `v`, or `v` with its writes discarded; `v` is a lane output or a lane ref                                             |
| `join(v)`                                  | The lane continued from `v`, a lane output of this concert                                                                              |
| `JsonOut(file, type)`, `MarkdownOut(file)` | An agent output: a file in its outbox, arriving as a `core.json-file` or `core.markdown` artifact                                       |
| `agent({ task, lane, role, ... })`         | A `repo.agent` node; outputs `report`, `staged`, `lane` unless it reads, and each declared output¹                                      |
| `seat({ role, identity, ... })`            | A function of `{ task, lane, ... }` that emits a `repo.agent` node²                                                                     |
| `check(lane, which?)`                      | A `repo.check` node: every named check, the one named, or an inline `{ run, timeout, ... }`; outputs `logs`, and `lane` unless it reads |
| `changeset(v)`                             | A `repo.changeset` node: version `v` as a patch series, output `changeset`                                                              |
| `apply(lane, { name: changeset }, opts)`   | A `repo.apply` node: the changesets applied in key order, each on a port of its name; output `lane`                                     |

¹ `agent` also takes `identity`, `refs` (each `{ artifact, when }`), `out`, `checks`, `readOnly`, `resume` and the
common options. `role` is a role name or `{ name, harness?, model?, thinking? }`.

² A seat takes `role`, `identity`, `refs`, `out`, `checks` and `readOnly`. A call takes `task`, `lane`, `resume` and the
common options, and may override the role and add refs, outputs, checks and read-only binds: its role fields override
the seat's, refs and outputs add with the call winning on a name, checks and binds are a union, and the result's outputs
are typed by both.

A check with no `timeout` has none: it runs until it ends or the concert is killed.

A lane ref given to `fork`, `read` or `changeset` becomes a `literal` of type `Lane`. N lanes merge by folding `apply`
over their changesets with `iter.fold`, a resolver agent joining on conflict.

## 13. IR emission, the worker protocol, diagnostics, test kit and renderers

### 13.1 IR emission contract (IR-01)

An emitter (the TypeScript SDK or any future one) must produce IR that:

- validates against the published IR schema and declares its IR version,
- has stable, unique ids that are paths, each proper prefix a declared scope or group and the last segment the node's
  name,
- carries the typed ports, edge kinds, group cardinalities and result rule described in architecture section 5,
- is byte-stable for identical params and composed config (CORE-06),
- names code nodes by worker reference `{runtime, module, export, code hash}`.

The core validates IR on load and rejects an unknown major version (CORE-16). The IR carries enough for a renderer and
for resume without consulting the composition's source.

### 13.2 Worker protocol (CORE-14)

Specified for later runtimes and out-of-process workers, implemented in-process for `ts` in the initial port:

- **Handshake.** Runtime name and version, supported IR version.
- **Invoke.** Node id, expansion path, input values and their port schemas, artifact references, context. Reply: outputs
  and an outcome, or an error.
- **Cancel and timeout.** The core can cancel an invocation. A worker must stop work and reply promptly.
- **Logs.** A worker can emit log lines tagged with the node instance, stored in the record. A code function writes one
  with `ctx.log(line)`.
- **Isolation.** A worker process is operator-trusted (NFR-05). It is not sandboxed by the core.

### 13.3 Diagnostics catalogue (CORE-17)

Stable code prefixes. Every diagnostic carries node id, scope, source location, message and a suggested next step.

- `IR` schema violation, unknown version.
- `REF` a Ref used where a value is required, a Ref that escaped its scope.
- `TYPE` edge schema mismatch, template variable missing or mistyped, a build that returns no node.
- `BOUND` a group without a bound, a bound over a configured cap on node instances or on a host's named count, a code
  node `timeout` that is not a whole number of milliseconds within the timer range (`BOUND.timeout`).
- `CFG` unclaimed key, schema violation, required key missing.
- `HOST` anything a host `validate` hook reports (for example a lane joined twice).
- `BUILD` an ambient read during build (SDK-11), or a build that yields different IR twice (SDK-12).
- `ASSERT` an `assert` that fails at build.
- `SCOPE` duplicate ids (two unlabelled nodes deriving one id need a `label`), duplicate `parMap` or `parFind` item
  keys, unresolved subcomposition, a code node function that is not exported, `reads` and `writes` contradictions.

Severity is `error` or `warning`. Any error stops before any concert starts (NFR-02).

### 13.4 Test kit (SDK-08)

- A **fake host** with configurable node kinds and scripted outcomes (including reject-then-accept).
- **Graph assertions:** `buildIr` builds a composition, `shapeOf` counts an IR's nodes, kinds and edges, and `composeIr`
  gives the plan's bounds or the diagnostics.
- **Stub concert:** `stubConcert` performs an IR over the real executor with scripted host nodes and stubbed code, for
  outcome propagation and resume tests.
- **Core-only fixtures** proving CORE-12.

### 13.5 Renderer contract

A renderer may rely on the IR and plan only, plus the event stream for live views (architecture section 11): node kinds,
scopes, edge kinds, cardinalities, expansions, and node-instance events keyed by node id and expansion path.

## 14. Worked examples (non-normative, illustrative syntax)

These come from the legacy compositions that were read for this design. They show that the API is expressive enough.
Syntax is a sketch.

**Repair until green** (build, then repair while checks are red, bounded by the composition's own param):

```ts
export const fixUntilGreen = composition(
  "fix_until_green",
  {
    ports: { build: Lane, prompt: Text },
    params: { maxRepairs: Int({ default: 2 }), model: Text() },
  },
  (params, { build, prompt }) => {
    const verify = (lane) => check(join(lane), "test");
    return loop.while((checked) => not(checked.ok), {
      init: verify(build),
      step: (checked) =>
        verify(
          agent({
            label: "repair",
            task: tpl("fix.md", { failures: checked.reason, request: prompt }),
            lane: join(checked.out.lane),
            role: { name: "builder", model: params.model },
            resume: true,
            refs: {
              logs: { artifact: checked.out.logs, when: "first, to see why the check failed" },
            },
          }),
        ),
      max: params.maxRepairs,
      tolerate: "rejected",
    });
  },
);
```

**Escalate and fan out over models:**

```ts
const builtOn = (m, prompt, run) =>
  use(fixUntilGreen, {
    build: agent({ task: prompt, lane: fork(run), role: { name: "builder", model: m } }).out.lane,
    prompt,
    model: m,
  });

escalate = composition("build_escalate", Params, ({ prompt, run, models }) =>
  iter.find(
    models,
    (m) => builtOn(m, prompt, run),
    (r) => r.ok,
  ),
);
fanout = composition("build_fanout", Params, ({ prompt, run, models }) =>
  firstOk(iter.parMap(models, (m) => builtOn(m, prompt, run), { onError: "continue" })),
);
```

**Lens, skeptic, consolidator** (the shape shared by four legacy chains):

```ts
const runs = iter.parMap(
  jobs,
  (job) => {
    const lens = agent({
      label: "lens",
      task: tpl("lens.md", { job, ctx }),
      lane: fresh(),
      role: job.lens,
      out: { findings: JsonOut("findings.json", Findings) },
    });
    const skeptic = agent({
      label: "skeptic",
      when: lens.out.findings.nonEmpty,
      task: tpl("skeptic.md", { job }),
      lane: fresh(),
      role: job.skeptic,
      refs: { findings: { artifact: lens.out.findings, when: "before judging any finding" } },
      out: { verdicts: JsonOut("skeptic.json", Verdicts) },
    });
    return { lens, skeptic };
  },
  { max: 14, onError: "continue" },
);
const merged = code(byFinding, { in: { runs }, out: Merged });
return agent({
  label: "consolidator",
  task: tpl("consolidate.md", { merged }),
  lane: fresh(),
  role: SOL,
  out: { review: MarkdownOut("review.md") },
});
```

**Plan from several angles, then synthesize** (`fork` several, then `join` the original):

```ts
const scout = agent({ label: "scout", task: prompt, lane: fresh(), role: "scout" });
const plans = iter.parMap(
  ANGLES,
  (a) =>
    agent({
      label: "plan",
      task: tpl("angle.md", { a, scouted: scout.out.report }),
      lane: fork(scout.out.lane),
      role: "planner",
    }),
  { onError: "continue" },
);
const good = code(renderOk, { in: { plans: plans.out.results }, out: { text: Text, nonEmpty: Bool } });
const synthesis = agent({
  label: "synthesis",
  task: tpl("synthesis.md", { good: good.out.text }),
  lane: join(scout.out.lane),
  role: "planner",
  when: good.out.nonEmpty,
});
return firstOk([synthesis.out.report, firstOk(plans).out.value.pick("report")]);
```

## 15. Coverage of the predecessor's workflows

| Predecessor workflow                     | Constructs it needs                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| scout_plan, build_quality, review_panel  | `agent`, `check`, `use`, `iter.parMap`, reducers                                                                                                   |
| full                                     | `use` of two subcompositions, `agent` joined to the result                                                                                         |
| build_escalate                           | `iter.find`, `use`, `fork` of one source                                                                                                           |
| build_fanout                             | `iter.parMap` with `onError: "continue"`, `firstOk`                                                                                                |
| plan_panel                               | `fork` and `join` of lane versions, `iter.parMap`, `Settled` fan-in, code node                                                                     |
| build_review                             | `loop` carrying two values, `tolerate` on a rejected check, a typed field in its condition                                                         |
| verification round (lenses, skeptics)    | `iter.parMap`, conditional second node, `assert` for the model-family policy, code node                                                            |
| rework, then a review gate, then a round | `use`, `loop`, staging by artifact ports, a final subcomposition use                                                                               |
| triage over a cross product              | `iter.parMap` over a cross product made by a code node, typed outputs, code node for regrouping, `assert`                                          |
| review of a locking change               | planner node whose output feeds a bounded `iter.parMap`, fallback via `ref.or`, expansion in a code node, a pack code node for the Gerrit artifact |

Coverage was assessed by reading the workflows (four verification and review chains with their helpers, and eight
general compositions). It was not exercised by running anything. Re-check each row when its workflow is ported.

## 16. Out of scope for the SDK in v1

- SDKs in languages other than TypeScript (the IR allows them).
- An expression language. Code nodes cover it.
- Perform-time-shaped graphs beyond bounded groups. A region's size may depend on a result only with a declared maximum.
- Dynamic subcomposition choice at perform time. A composition may select among subcompositions at build time from
  params.
