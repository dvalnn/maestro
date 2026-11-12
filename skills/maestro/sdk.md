# SDK

The API a composition is written in: `@maestro/sdk` for the graph, `@maestro/host-repo-sdk` for lanes, agents and
checks. How a file uses it is [composition.md](composition.md).

## `@maestro/sdk`

| Name                                                        | Gives                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `composition(name, { doc, params, examples }, fn)`          | A composition; `fn(params)` returns its result node                            |
| `Text`, `Int`, `Float`, `Bool`                              | Value types, called with `{ default, description }`; no default means required |
| `Enum([...])`, `List(T)`, `Struct({ ... })`, `Json(schema)` | Choice and structured value types                                              |
| `Optional(T)`                                               | A param or port that may be absent: not required, `undefined` in the build     |
| `File()`, `Dir()`, `JsonFile(T)`, `Markdown()`              | Artifact types                                                                 |
| `code(fn, { in, out, timeout })`                            | A code node; `fn` is an exported `(inputs, ctx) => outputs`                    |
| `reject(reason, outputs?)`                                  | A code node's `rejected` verdict, returned from `fn`                           |
| `use(sub, ports, { params })`                               | A subcomposition, in a scope of its own; leave out `Optional` ports            |
| `assert(cond, message)`                                     | A build-time check over plain values                                           |
| `assert(ref, message, { onFail })`                          | A perform-time check, settling `rejected` or `failed` when false               |
| `iter.map(items, body, { onError })`                        | `body(item)` per item, in order; `onError` (`"stop"` or `"continue"`) required |
| `iter.parMap(items, body, { onError, key })`                | `body(item)` per item, all at once; `key(item)` names each instance            |
| `iter.find(items, body, cond)`                              | In order, up to the first result meeting `cond`                                |
| `iter.parFind(items, body, cond)`                           | All at once, the first to meet `cond` wins                                     |
| `iter.fold(items, { first, step })`                         | An accumulator carried item to item                                            |
| `loop.while(cond, { init, step, max, tolerate })`           | Steps while `cond(state)` holds, tested first: 0 to `max` steps                |
| `loop.doWhile(cond, { init, step, max, tolerate })`         | Steps, then tests each result: 1 to `max` steps                                |
| `firstOk(results)`, `okOnly(results)`                       | The first `ok` result; the `ok` ones                                           |
| `allSettled(results)`                                       | Every result with its outcome                                                  |
| `readJson(ref)`                                             | A JSON artifact read into a typed, schema-checked Ref                          |
| `not(ref)`                                                  | A negated `Ref<Bool>`                                                          |

`items` is a written list or a Ref; over a Ref, `max` is required. A loop's `max` is a literal or a param.

A code function's `ctx` carries:

- `signal`, aborted when the concert is killed or the node times out. Pass it to what the function starts, as
  `Bun.spawn(cmd, { signal: ctx.signal })`, or the process outlives the node.
- `env.repo`: `target`, `base`, `sparse` (as configured, or `null`), `revision` (the commit `base` names, or `null`) and
  `profiles` (a digest over every profile's files).

A code node that settles `failed` keeps its scratch directory, its log saying `scratch kept at <path>`.

## `@maestro/host-repo-sdk`

| Name                                    | Gives                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `fresh(base?)`                          | A new lane cut at `base`, else `target.base`, else the target's `HEAD`                             |
| `fork(v)`                               | A copy of version `v`; any number of nodes may fork one version                                    |
| `extend(v)`                             | The lane continued from `v`, at most once                                                          |
| `read(v)`                               | `v` with writes discarded; the node outputs no lane                                                |
| `seat(name, { profile?, ... })`         | A coding agent; outputs `report`, `staged`, `lane`, `session` and declared ones                    |
| `check(lane, which?)`                   | Every named check, the one named, or an inline `{ run, timeout, ... }`; keeps `output`             |
| `changeset(v, { message?, since? })`    | `v` as a changeset, `message` its commit message, `since` an earlier version, only later patches   |
| `commits(revs)`                         | Target commits `revs` names as a version; fork or read it, never extend                            |
| `apply(lane, cs, { strategy })`         | Changeset `cs` applied to a lane; `"3way"` (default) or `"clean"`                                  |
| `JsonOut(file, T)`, `MarkdownOut(file)` | A declared agent output, written in its outbox at `/out/<file>`                                    |
| `Lane`                                  | The lane version type, and the lane ref param type                                                 |
| `yamlOf(value)`                         | From `@maestro/host-repo-sdk/yaml`: a typed value as YAML, as a relay and `outputs.yaml` render it |

## Seats

`seat(name, options)` bundles an agent's standing setup once:

- `profile`: a bare name or `<pack>/<name>`, the seat's own name by default ([profiles.md](profiles.md)).
- `verdict: true`: an agent that rules on work, `ok` or `rejected`.
- `encore: false`: its agents start fresh in an encore.
- `out`: declared outputs. `reply`: typed reply fields every call gives. `checks`: names from `target.checks` the agent
  may run with its `check <name>` command.

A call takes `task`, `lane` and the common options, and may add:

- `session`: an agent's `out.session`, continued in place, told what changed since its last turn.
- `attachments`: `{ name: { artifact, hint } }`, each mounted read-only at `/in/<name>` (a file with its source's
  extension added), `hint` saying when to read it.
- `relay`: `{ name: ref }`, each inlined in the task under `## <name>`: a Markdown output as text, a string as it is,
  any other typed value as YAML.
- outputs and checks.
- `reply`: `{ name: type }`, typed fields of the agent's envelope beside `report`. Each is an output of its type, which
  the host validates, correcting the agent, at most twice, when it is off the type. Structured data goes here, Markdown
  and large files in outbox files. A name is none of `report`, `blocked`, `outcome`, `reason`, `lane`, `staged`,
  `session` or an output's.

A call sets no runtime, instructions, limits or context: an agent that needs another budget is another seat on another
profile.

An agent ending `ok` must write every declared file and give every `reply` field, valid, or the instance fails; a
rejecting verdict agent gives its fields too. Only a verdict agent rejects; one rejecting without its declared files
ends `rejected` with no outputs. Any agent may report itself blocked: it ends `failed`, reason `blocked: <cause>`, no
outputs.
