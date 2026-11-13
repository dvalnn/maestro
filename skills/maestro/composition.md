# Writing a composition

Steps for a new composition file, then its file rules, build model and a worked example. The API is [sdk.md](sdk.md).
Done when the file composes and a stub concert of it settles as intended.

## Steps

1. **Check the classics pack first.** A shape it already has is a param set away; a new file is for a shape it lacks.
2. **Write the file** at `.maestro/<id>.ts`, by the file rules below, starting from the worked example. Done when it
   holds one exported composition with an example set.
3. **Compose it**: `maestro compose .maestro/<id>.ts`. Fix each diagnostic by its hint or the table below, and compose
   again. Done on exit 0, with the plan's node counts and `repo.agent` bound what you meant.
4. **Rehearse it** as a stub concert ([stub.md](stub.md)): `maestro perform .maestro/<id>.ts --preset stub [flags]`.
   Done when it settles with the outcome you expected.
5. **Hand it over**: the file's path, its params and the profiles it needs. Committing it is the user's.

## File rules

- One file, one exported composition, named `<stem>.<name>`: the stem is its pack id.
- The stem is lower case, starts with a letter, then letters, digits, `_` or `-`, and is no installed pack's id.
- At least one example set (`examples: [{ ... }]`); it serves compose only.
- A bare file's own compositions take params from flags, their example set and defaults: no config key reaches them. To
  configure them, make the file a pack ([packs.md](packs.md)). The installed packs' compositions it uses keep their own
  keys.
- Import `@maestro/sdk`, `@maestro/host-repo-sdk`, `node:` builtins and relative files. The binary resolves the two SDK
  imports to its own copies, so no install step.
- A prompt longer than a line is a Markdown file in `.maestro/<id>/prompts/`, by [prompts.md](prompts.md).
- A code node's function is exported by the composition file itself, or compose fails it. To run one from a relative
  file, re-export it: `import { tally } from "./lib/util"; export { tally };`.

## The build model

The build function runs once, at compose, over plain values; nodes run later, at perform.

- **Params are plain**: a plain `if` or loop over them shapes the graph.
- **Node outputs are Refs**, with no value until perform. A Ref in a template string or an index fails compose with
  `REF.value`. In an `if` or `? :` a Ref is always truthy, so the build silently takes one branch: branch on params
  only, and on Refs through:
  - `ref.get("a.b")` reads a field; `ref.or(fallback)` defaults a `rejected` or `skipped` one.
  - `not(ref)`; `when: ref` on any node skips it when false; `when(ref, value)` is `value` only when `ref` holds;
    `lookup(table, key)` picks a build-time table's entry by a Ref key.
  - Text built from Refs comes from a code node; an artifact reaches an agent as an attachment.
- **Every node returns a result handle**: `.ok` and `.reason`, and `.out.<port>` per output.
- **Every node takes** `label` (its id; give one to every agent and check), `when` (a `Ref<Bool>` guard) and
  `tolerate: "rejected"` (run on a rejected upstream's outputs). A node reading only `.ok` or `.reason` runs after a
  rejected upstream without `tolerate`.

## Worked example

An agent builds the task in a fresh lane; while the `test` check is red, a repair agent continues the builder's session
with the check's logs attached; the result leaves as a changeset. It needs `target.checks.test` and a `builder` profile.

```ts
import { changeset, check, extend, fresh, seat } from "@maestro/host-repo-sdk";
import { composition, Int, loop, not, Text } from "@maestro/sdk";

const builder = seat("builder", { checks: ["test"] });

export const fix = composition(
  "fix",
  {
    doc: "Builds a task, repairs it while the test check is red, and leaves a changeset.",
    params: { task: Text(), repairs: Int({ default: 2 }) },
    examples: [{ task: "Make greet.sh print hello" }],
  },
  ({ task, repairs }) => {
    const built = builder({ label: "build", task, lane: fresh() });
    const green = loop.while((c) => not(c.ok), {
      init: check(extend(built.out.lane), "test", { label: "test" }),
      step: (c) => {
        const repaired = builder({
          label: "repair",
          task: "The test check is red. Fix the code so it passes.",
          lane: extend(c.out.lane),
          session: built.out.session,
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

Its plan: `fix: up to 10 node instances, up to 3 repo.agent`. If the loop ends with the check still red, the concert
settles `rejected` at the loop's last `test`, its reason the check's, and no changeset is made.

## Diagnostics an author meets

Codes show under `--json`; human output leads with `error:` and the message.

| Code              | Means                                                   | Fix                                                                                 |
| ----------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `REF.value`       | A Ref used as a plain value while building              | Lift it as the hint says, or use a code node                                        |
| `REF.bool`        | A guard or condition that is not a `Ref<Bool>`          | Pass a Bool output, such as `check.ok`                                              |
| `SCOPE.export`    | A function given to `code` is not a named export        | `export` it from the file and pass it by name                                       |
| `SCOPE.duplicate` | Two `loop` or `allSettled` calls in one scope           | Give one a `label`                                                                  |
| `CFG.examples`    | No example set                                          | Add `examples: [{ ... }]`                                                           |
| `HOST.lane`       | A version extended twice                                | `fork` it in all but one of them                                                    |
| `HOST.session`    | A session on two harnesses, or with two runners at once | Give both the same harness; continue it in one node, or chain through `out.session` |
| `BOUND.max`       | A group over a Ref without `max`, or a bad `max`        | Set `max` from a literal or a param                                                 |
| `CFG.required`    | A required param has no value                           | Pass its flag, or set it in config for a pack; the example set serves compose only  |
