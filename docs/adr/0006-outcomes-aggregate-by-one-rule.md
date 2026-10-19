---
status: accepted
---

# Outcomes aggregate by one rule, and fan-in nodes see settled inputs

Wherever several outcomes collapse into one, the worst wins: `failed` > `rejected` > `skipped` > `ok`. `Outcome`,
`Settled` and one `worstOutcome` function live in `packages/ir`, the package every emitter and consumer already depends
on, and are the only implementation. The SDK, the executor and the stdlib reducers call it. The rule applies to:

- a `parMap` or `map` member whose body returns several results,
- a `parMap` or `map` group with `onError: "stop"`,
- `firstOk` when no input is `ok`.

**`onError` has no default.** The SDK requires it on every `parMap` and `map`, as the IR already does (ADR 0004).

**Stop.** The group's outcome is the worst member outcome, and its `reason` is that of the first such member by item
order. When the first member settles non-ok, no further member starts, and running members are cancelled through their
kind's cancel hook. A member cancelled this way settles `skipped` with the reason `cancelled: <instance> <outcome>`, so
it never worsens the group's outcome. Cancelling a concert still settles running instances `failed` (architecture
section 7).

**Fan-in.** A code node with `fanin: true` runs once all its upstreams have settled, whatever their outcome. It receives
each `data` input as `Settled(T)`, and a `collect` input as `Settled(T)[]` as before. Its own `when` guard and control
edges apply as on any node.

**Reducer inputs.** A reducer's ports are a `parMap` or `map`'s `results`, or one `data` input per output it was given,
`in0` to `inN` in order. It reads either as one `Settled[]` in that order. Given such a group's handle, the SDK uses its
`results`.

**Port schemas describe the delivered value.** A `parMap` or `map`'s `results` port, every input fed by a `collect` edge
and every `data` input of a fan-in node declare `Settled`, built by `settledSchema` in `packages/ir`. A `data` edge into
a fan-in input checks the upstream schema against the port's `value` subschema.

**`Settled`'s shape.** An `ok` one carries a value and no reason. A `rejected` or `failed` one carries a reason. A
`rejected` one carries a value when its node rejected with outputs (ADR 0008). A rejected `parMap` or `map` member
carries one when each of its result nodes has outputs, in the same shape as an `ok` member's. A value on `failed`, and a
reason on `skipped`, stay optional until a slice pins them. The schema is closed to `outcome`, `value` and `reason`, so
a misspelt field fails; opening it later breaks nothing already valid.

**`firstOk`.** Delivers the first `ok` input's value. With no `ok` input it settles `failed` if any input failed, else
`rejected`, with the inputs' reasons. A code node can only reject or throw, so `skipped` inputs count as `rejected`.

## Considered options

- **A default for `onError`.** `sdk-spec.md` said stop and `architecture.md` said continue, and every worked example
  writes the field. Requiring it removes the conflict for one field per group.
- **Stop without cancellation.** Every member runs to completion and the group's spend is thrown away once its outcome
  is decided. Rejected.
- **Drain** (start no new member, let running ones finish). Keeps their results for a resume, but keeps spending on a
  run whose cause, often quota or environment, likely fails them too. Rejected for cancel.
- **An edge-level "deliver as Settled" marker** (expected by ADR 0004). Per-edge control, but an IR 1.1 bump and a
  second mechanism that every reducer would set the same way. The `fanin` flag already marks every reducer.
- **`firstOk` always `rejected` when nothing is `ok`.** Reports a crashed run as a negative verdict, so the operator
  gives up instead of resuming.

## Consequences

- A `fanin` node cannot mix inputs that must be `ok` with settled ones. A strict input is checked upstream.
- Under stop, which members ran depends on timing, so the record varies between runs. The outcome does not.
- The plan-panel example indexes no settled list:
  `firstOk([synthesis.out.report, firstOk(plans).out.value.get("report")])` falls back to a plan that succeeded. A
  member whose body returns one result has that result's outputs as its value.
- `Outcome`, `Settled` and `worstOutcome` land in `packages/ir` before the SDK and executor build on them. The home is
  revisited if those slices find a better one.
