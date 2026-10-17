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

- `outcome`, `ok`, and `reason` (text, present when rejected or failed),
- one port per declared output, under `out`,
- any extra ports its kind defines (for a host kind, for example a lane).

All of these are Refs. A node accepts common options: `label`, `when` and `tolerate`.

### 4.1 Core node constructors

| Constructor              | Purpose                                                                                  | Key arguments                                           | Result                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `code(fn, opts)`         | Run the author's function over typed inputs.                                             | `in` ports, `out` schema, `reads`, `writes`, `timeout`  | outputs per `out`                               |
| `map(items, body, opts)` | Instantiate `body` once per item, in parallel.                                           | `items`, body, `max`, `onError`                         | `Settled(R)[]` with static cardinality metadata |
| `seq(items, body, opts)` | Instantiate `body` per item in order, stop at the first item whose result meets `until`. | `items`, body, `until`, `max`                           | the stopping result, or the last                |
| `repeat(opts)`           | Bounded loop carrying typed state.                                                       | `init`, `step(state, i)`, `until`, `max`, `tolerate`    | the last state                                  |
| `assert(cond, message)`  | A policy or invariant.                                                                   | a boolean                                               | none                                            |
| `use(sub, ports, opts)`  | Instantiate a subcomposition.                                                            | `ports` (Refs or plain values), `opts.params` overrides | the subcomposition's declared outputs           |

Semantics each constructor must honor:

- **`code`.** Runs only at perform, never during build or compose (ADR 0009). Its function is an exported
  `(inputs, ctx) => outputs`, sync or async, with inputs and outputs keyed by port name (ADR 0008). It can return
  `reject(reason, outputs?)` for a negative verdict, which becomes outcome `rejected`.
- **`map`.** `items` may be a build-time list or a Ref resolved later. `max` is mandatory when the item count is not
  known at compose time, and compose reports "up to N". A list of unknown length comes from a code node and feeds a
  bounded `map` (D-16). Items are keyed: a primitive item by its value, any other item by index, or by an optional key
  function `(item) => key`. Give a key function whenever items are records or paths, so keys stay short and survive
  reordering. A key is sanitized to `[A-Za-z0-9_.-]`, anything else becoming `_`, and keys that sanitize alike are
  duplicates: a compose error for a build-time list without a key function (D-18, SDK-13), and a failed `map` when a key
  function runs, at perform (ADR 0009), or the list is known only at perform time. Keys only name node instances for
  `ls` and lane refs. `onError` is required. With `"settle"` a non-ok member becomes a `Settled` value and the group is
  `ok`. With `"propagate"` the group takes the worst member outcome, and the first non-ok member cancels the rest (ADR
  0006).
- **`seq`.** Covers escalation over an ordered list. `until` gets a member's result and returns a `Ref<Bool>`. Members
  after a satisfied `until` never start. The bound is `items.length` or `max`. A `seq` with `until` stays an "up to N"
  region in the plan. A `seq` over no items settles `skipped`.
- **`repeat`.** The step receives the previous state and the iteration index. At least one iteration runs: `until` gets
  each new state, never `init`, and returns a `Ref<Bool>`. A `repeat` stays an "up to `max`" region in the plan, for
  bounds and rendering. `max` must be known at compose time, from a literal or a param. State edges are tolerant of
  `rejected` only if `tolerate` says so. A state port named `index` is a build error, since the step's index takes that
  name.
- **`assert`.** Evaluated at build if the condition is a plain value, and at perform time otherwise. A failed build-time
  assert is a diagnostic error. A perform-time assert yields a `rejected` or `failed` node, whichever the assert
  declares.
- **`use`.** Creates a scope in the IR (architecture section 5). Params of the subcomposition may be set at the use
  site, which has the highest precedence (D-17).

Host SDKs add constructors with the same Result handle shape (section 12).

### 4.2 Guards and tolerance

- **`when: Ref<Bool>`** on any node. A false guard makes the node `skipped`.
- **`tolerate: "rejected"`** on a consuming node or a `repeat` state edge lets the node run after a `rejected` upstream.
  It then receives `reason`, and the upstream's outputs when it rejected with them. Reading a declared output of a
  rejection that carried none fails the node, naming the upstream. Without it a non-ok upstream makes the node `skipped`
  (CORE-04). `failed` and `skipped` are never tolerable.

## 5. Refs and mapping between nodes

A **Ref** is a symbolic handle to a typed value that will exist at perform time. Rules:

- **No branching.** Using a Ref where a plain value is required (`if (ref)`, string concatenation, array indexing by a
  Ref) throws a build diagnostic that names the lifting alternative. This is what keeps the graph decidable (D-04).
- **Lifting combinators** (all produce visible nodes in the graph, never hidden ones):
  - `ref.pick(path)` selects a field of a structured value.
  - `zip(a, b, { on? })` pairs the items of two lists, by position or by the key field `on`.
  - `when(cond, ...)` and `ref.or(default)` for guards and defaults.
  - `lookup(table, key)` indexes a plain table by a Ref key.

  A lift's id names its source node and what it does, so it needs no label: `review.out.result.pick("summary")` is
  `review_summary`, and `x.or(…)` is `x_or`. Every lift also takes `label`, for the rare clash that remains.

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
  ref, written `<concert id>.<node instance id>`, for forking a lane left by an earlier concert (D-27).
- The CLI validates params before build. A required param that is absent, or a constraint violation (for example a list
  of fewer than two models for a comparison), is a usage error with a next-step message (CLI-06).
- Every composition declares at least one example input set. `compose` uses the first one, over every YAML layer and
  under the flags, a given flag overriding its own key, and `perform` never does (D-19).
- What a composition needs (plan node kinds, instance counts, host counts) is derived by compose and host `validate`,
  never declared (SDK-06).

## 10. Config

- Params carry defaults declared in code (CFG-03).
- Composed config reaches the build function. Values that bound groups (`max` on `repeat` and `map`) come from params
  and are therefore known at compose time.
- Precedence, highest first (CFG-04, D-17): the use site for a subcomposition or the CLI flag for a root composition,
  then, for `compose`, the example set, then profile, workspace and user YAML, then the default. YAML keys live under
  the pack id and then the composition id.
- A key that no installed registrant claims fails compose with a did-you-mean hint. A key claimed by an installed but
  unused registrant is ignored (CFG-05, D-24). The composed config view reports value provenance (CFG-06).
- Core config is not visible to compositions. They never read engine settings.

## 11. Standard library

The standard library is built only from the constructors above (NFR-09). Initial contents (SDK-07):

- **Reducers.** `firstOk(results)`, `okOnly(results)` and `settle(results)`. Marked fan-in in the IR, so they run once
  every input has settled and receive each as `Settled` (ADR 0006). They take a map's handle or a list of outputs.
  `firstOk` with no `ok` input settles `failed` if any input failed, else `rejected`.
- **Templating.** `tpl` as above. Prompt files are text artifacts staged by the consuming host node.
- **Readers.** Typed readers for JSON and text artifacts, with schema validation, as code nodes.

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

The coding-agent host SDK exports at least `agent`, `check`, and the lane constructors. Its exact surface is in that
host's own spec, written during the host slice.

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
- `SCOPE` duplicate ids (two unlabelled nodes deriving one id need a `label`), duplicate map item keys, unresolved
  subcomposition, a code node function that is not exported, `reads` and `writes` contradictions.

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
    ports: { build: AgentResult, prompt: Text },
    params: { maxRepairs: Int({ default: 2 }) },
  },
  (params, { build, prompt }) => {
    const check = (b) => checkNode({ lane: join(b.lane), prompt });
    return repeat({
      init: check(build),
      step: (checked) =>
        check(
          agent("build", {
            lane: join(checked.lane),
            prompt: tpl("fix.md", {
              failures: checked.reason,
              logs: checked.out.logs,
              request: prompt,
            }),
          }),
        ),
      until: (c) => c.ok,
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
    build: agent("build", { prompt, lane: fork(run), role: { model: m } }),
    prompt,
  });

escalate = composition("build_escalate", Params, ({ prompt, run, models }) =>
  seq(models, (m) => builtOn(m, prompt, run), { until: (r) => r.ok }),
);
fanout = composition("build_fanout", Params, ({ prompt, run, models }) =>
  firstOk(map(models, (m) => builtOn(m, prompt, run), { onError: "settle" })),
);
```

**Lens, skeptic, consolidator** (the shape shared by four legacy chains):

```ts
const runs = map(
  jobs,
  (job) => {
    const lens = agent("review", {
      prompt: tpl("lens.md", { job, ctx }),
      role: job.lens,
      out: { findings: Json("findings.json", Findings) },
    });
    const skeptic = agent("review", {
      when: lens.out.findings.nonEmpty,
      role: job.skeptic,
      prompt: tpl("skeptic.md", { job, findings: lens.out.findings }),
      out: { verdicts: Json("skeptic.json", Verdicts) },
    });
    return { lens, skeptic };
  },
  { max: 14, onError: "settle" },
);
const merged = code(byFinding, { in: { runs }, out: Merged });
return agent("review", {
  prompt: tpl("consolidate.md", { merged }),
  role: SOL,
  out: { report: Markdown("review.md") },
});
```

**Plan from several angles, then synthesize** (`fork` several, then `join` the original):

```ts
const scout = agent("scout", { prompt, lane: fresh() });
const plans = map(
  ANGLES,
  (a) =>
    agent("plan", {
      lane: fork(scout.lane),
      prompt: tpl("angle.md", { a, scouted }),
    }),
  { onError: "settle" },
);
const good = code(renderOk, { in: { plans: plans.out.results }, out: { text: Text, nonEmpty: Bool } });
const synthesis = agent("plan", {
  lane: join(scout.lane),
  when: good.out.nonEmpty,
  prompt: tpl("synthesis.md", { good: good.out.text }),
});
return firstOk([synthesis.out.text, firstOk(plans).out.value.pick("result.text")]);
```

## 15. Coverage of the predecessor's workflows

| Predecessor workflow                     | Constructs it needs                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| scout_plan, build_quality, review_panel  | `agent`, `check`, `use`, `map`, reducers                                                                                                   |
| full                                     | `use` of two subcompositions, `agent` joined to the result                                                                                 |
| build_escalate                           | `seq`, `use`, `fork` of one source                                                                                                         |
| build_fanout                             | `map` with `onError: "settle"`, `firstOk`                                                                                                  |
| plan_panel                               | `fork` and `join` of lane versions, `map`, `Settled` fan-in, code node                                                                     |
| build_review                             | `repeat` carrying two values, `tolerate` on a rejected check, a typed field in `until`                                                     |
| verification round (lenses, skeptics)    | `map`, conditional second node, `assert` for the model-family policy, code node                                                            |
| rework, then a review gate, then a round | `use`, `repeat`, staging by artifact ports, a final subcomposition use                                                                     |
| triage over a cross product              | `map` over a cross product made by a code node, typed outputs, code node for regrouping, `assert`                                          |
| review of a locking change               | planner node whose output feeds a bounded `map`, fallback via `ref.or`, expansion in a code node, a pack code node for the Gerrit artifact |

Coverage was assessed by reading the workflows (four verification and review chains with their helpers, and eight
general compositions). It was not exercised by running anything. Re-check each row when its workflow is ported.

## 16. Out of scope for the SDK in v1

- SDKs in languages other than TypeScript (the IR allows them).
- An expression language. Code nodes cover it.
- Perform-time-shaped graphs beyond bounded groups. A region's size may depend on a result only with a declared maximum.
- Dynamic subcomposition choice at perform time. A composition may select among subcompositions at build time from
  params.
