# Writing a composition

Steps for the compose-and-fix loop of a new composition file, then reference: file rules, the build model, the API at
surface, and a worked example. Done when the file composes and a stub concert of it settles as intended.

## Steps

1. **Check the repertoire first.** A shape it already has is a param set away; a new file is for a shape it lacks.
2. **Write the file** at `.maestro/<id>.ts` in the workspace, by the file rules below, starting from the worked example.
   Done when it holds one exported composition with an example set.
3. **Compose it:** `maestro compose .maestro/<id>.ts`. For each diagnostic, read its code and hint, fix the file, and
   compose again. Done on exit 0, with the plan's node counts and `repo.agent` bound what you meant.
4. **Rehearse it as a stub concert** (SKILL.md, Stub concerts):
   `maestro perform .maestro/<id>.ts --profile stub [param flags]`. Done when the concert settles with the outcome you
   expected.
5. **Hand it over.** Tell the user the file's path, its params, and the roles it needs mapped. Committing it is theirs.

## File rules

- One file, one exported composition. The file's stem is its pack id, so the composition is `<stem>.<name>` in `ls`.
- The stem is lower case, starts with a letter, then letters, digits, `_` or `-`, and is no installed pack's id.
- At least one example set (`examples: [{ ... }]`), which serves compose only ([running.md](running.md), Compose).
- A bare file takes params from flags, its example set and defaults only; no config key reaches it. Make it a pack
  ([packs.md](packs.md)) to configure it.
- Import `@maestro/sdk`, `@maestro/host-repo-sdk`, `node:` builtins and relative files. The `maestro` binary resolves
  the two SDK imports to its own copies, so the file needs no install step.

## The build model

The build function runs once, at compose, over plain values. Nodes run later, at perform.

- **Params are plain**: known while building, so a plain `if` or loop over them shapes the graph.
- **Node outputs are Refs**: symbolic handles with no value until perform. A Ref in a template string or an index fails
  compose with `REF.value`. In an `if` or a `? :` a Ref is always truthy, so the build takes one branch with no error:
  branch on params only. Instead:
  - `ref.get("a.b")` reads a field; `ref.or(fallback)` defaults a `rejected` or `skipped` one.
  - `not(ref)` negates a `Ref<Bool>`; `when: ref` on any node skips it when false; `when(ref, value)` is `value` only
    when `ref` is true, and `lookup(table, key)` picks a build-time table's entry by a Ref key.
  - Text built from Refs comes from a code node; an artifact reaches an agent as an attachment.
- **Every node returns a result handle**: `.ok` and `.reason` (status ports), `.out.<port>` for each output.
- **Common options** on every node: `label` (its id; give one to every agent and check), `when` (a `Ref<Bool>` guard),
  `tolerate: "rejected"` (run on a rejected upstream's outputs).
- A node reading only `.ok` or `.reason` runs after a rejected upstream with no `tolerate`: `not(check.ok)` needs none.

## The API at surface

From `@maestro/sdk`:

| Name                                                        | Gives                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `composition(name, { doc, params, examples }, fn)`          | A composition; `fn(params)` returns its result node                                                                       |
| `Text`, `Int`, `Float`, `Bool`                              | Value types, called with `{ default, description }`; no default means required                                            |
| `Enum([...])`, `List(T)`, `Struct({ ... })`, `Json(schema)` | Choice and structured value types                                                                                         |
| `File()`, `Dir()`, `JsonFile(T)`, `Markdown()`              | Artifact types                                                                                                            |
| `code(fn, { in, out, timeout })`                            | A code node; `fn` is an exported `(inputs, ctx) => outputs`; `timeout` is a duration                                      |
| `reject(reason, outputs?)`                                  | A code node's `rejected` verdict, returned from `fn`                                                                      |
| `use(sub, ports, { params })`                               | A subcomposition, in a scope of its own                                                                                   |
| `assert(cond, message)`                                     | A build-time check over plain values                                                                                      |
| `assert(ref, message, { onFail })`                          | A perform-time check, settling `rejected` or `failed` when false                                                          |
| `iter.map(items, body, { onError })`                        | `body(item)` per item, in order; the options and `onError` (`"stop"` or `"continue"`) are required                        |
| `iter.parMap(items, body, { onError, key })`                | `body(item)` per item, all at once; `onError` required as for `map`; `key(item)` gives each item a readable instance name |
| `iter.find(items, body, cond)`                              | In order, up to the first result meeting `cond`                                                                           |
| `iter.parFind(items, body, cond)`                           | All at once, the first to meet `cond` wins                                                                                |
| `iter.fold(items, { first, step })`                         | An accumulator carried item to item                                                                                       |
| `loop.while(cond, { init, step, max, tolerate })`           | Steps while `cond(state)` holds, tested first: 0 to `max` steps                                                           |
| `loop.doWhile(cond, { init, step, max, tolerate })`         | Steps, then tests each result: 1 to `max` steps                                                                           |
| `firstOk(results)`, `okOnly(results)`                       | The first `ok` result; the `ok` ones                                                                                      |
| `allSettled(results)`                                       | Every result with its outcome                                                                                             |
| `readJson(ref)`                                             | A JSON artifact read into a typed, schema-checked Ref                                                                     |
| `not(ref)`                                                  | A negated `Ref<Bool>`                                                                                                     |

`items` is a written list or a Ref; over a Ref, `max` is required. `max` of a loop is a literal or a param.

From `@maestro/host-repo-sdk`:

| Name                                    | Gives                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `fresh(base?)`                          | A new lane cut at `base`, else `target.base`, else the target's `HEAD`      |
| `fork(v)`                               | A copy of version `v`; any number of nodes may fork one version             |
| `extend(v, { resume? })`                | The lane continued from `v`, at most once; `resume` continues its session   |
| `read(v)`                               | `v` with writes discarded; the node outputs no lane                         |
| `agent({ task, lane, role, ... })`      | A coding agent; outputs `report`, `staged`, `lane` and its declared outputs |
| `seat({ role, identity, ... })`         | An agent's standing setup, called with `{ task, lane, ... }` per agent      |
| `check(lane, which?)`                   | Every named check, the one named, or an inline `{ run, timeout, ... }`      |
| `changeset(v)`                          | Version `v` as a changeset; end a composition on one to deliver results     |
| `apply(lane, cs, { strategy })`         | Changeset `cs` applied to a lane; `"3way"` (default) or `"clean"`           |
| `JsonOut(file, T)`, `MarkdownOut(file)` | A declared agent output, written in its outbox at `/out/<file>`             |
| `Lane`                                  | The lane version type, and the lane ref param type                          |

`agent` also takes `identity` (standing text appended to the harness's system prompt), `attachments`
(`{ name: { artifact, hint } }`, each mounted read-only at `/in/<name>`, `hint` saying when to read it), `out` (declared
outputs), `checks` (names from `target.checks` the agent may run with its `check <name>` command) and `readOnly`
(absolute host paths). `role` is a role name, or `{ name, harness?, model?, thinking? }` to override it.

An agent ending `ok` must write every declared file, valid, or the instance fails; one that rejects without them ends
`rejected` with no outputs.

## Worked example

An agent builds the task in a fresh lane; the `test` check verifies it; while the check is red, a repair agent resumes
the builder's session with the check's logs attached; the result leaves as a changeset. It needs `target.checks.test`
and a `builder` role.

```ts
import { agent, changeset, check, extend, fresh } from "@maestro/host-repo-sdk";
import { composition, Int, loop, not, Text } from "@maestro/sdk";

export const fix = composition(
  "fix",
  {
    doc: "Builds a task, repairs it while the test check is red, and leaves a changeset.",
    params: { task: Text(), repairs: Int({ default: 2 }) },
    examples: [{ task: "Make greet.sh print hello" }],
  },
  ({ task, repairs }) => {
    const built = agent({ label: "build", task, lane: fresh(), role: "builder", checks: ["test"] });
    const green = loop.while((c) => not(c.ok), {
      init: check(extend(built.out.lane), "test", { label: "test" }),
      step: (c) => {
        const repaired = agent({
          label: "repair",
          task: "The test check is red. Fix the code so it passes.",
          lane: extend(c.out.lane, { resume: true }),
          role: "builder",
          checks: ["test"],
          attachments: { logs: { artifact: c.out.logs, hint: "first, to see why the check failed" } },
        });
        return check(extend(repaired.out.lane), "test", { label: "test" });
      },
      max: repairs,
      tolerate: "rejected",
    });
    return changeset(green.out.lane);
  },
);
```

Its plan: `fix: up to 10 node instances, up to 3 repo.agent`. Perform it with
`maestro perform .maestro/fix.ts --task "..."`. If the loop ends with the check still red, the concert settles
`rejected` at the loop's last `test`, its reason the check's, and no changeset is made.

## Diagnostics an author meets

| Code           | Means                                                   | Fix                                                                                |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `REF.value`    | A Ref used as a plain value while building              | Lift it as the hint says, or use a code node                                       |
| `REF.bool`     | A guard or condition that is not a `Ref<Bool>`          | Pass a Bool output, such as `check.ok`                                             |
| `SCOPE.export` | A function given to `code` is not a named export        | `export` it from the file and pass it by name                                      |
| `CFG.examples` | No example set                                          | Add `examples: [{ ... }]`                                                          |
| `HOST.lane`    | A version extended twice                                | `fork` it in all but one of them                                                   |
| `HOST.resume`  | `resume` on a version no agent or extending check wrote | Drop `resume`, or extend the agent's version                                       |
| `BOUND.max`    | A group over a Ref without `max`, or a bad `max`        | Set `max` from a literal or a param                                                |
| `CFG.required` | A required param has no value                           | Pass its flag, or set it in config for a pack; the example set serves compose only |
