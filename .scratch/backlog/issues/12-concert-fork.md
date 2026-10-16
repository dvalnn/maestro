# Concert fork

Status: needs-triage

Owner ruling 2026-10-16: start a new concert from a finished one's results, like the legacy `--from` ("start a fresh run
from a copy of run ID's series"). It replaces the content-hash cache dropped from V1. Timing waits for S8's lanes: then
it is prototyped and lands in V1 or after.

The shape is settled: selection by naming. A composition with ports may run at the root, and the CLI feeds each port
from a recorded node instance of an earlier concert, written `<concert id>.<node instance id>` like a lane ref
(HOST-13). This lifts sdk-spec 2's "a composition with ports runs only through `use`".

```ts
export const repairFromPlan = composition(
  "repair_from_plan",
  {
    params: { request: Text },
    ports: { plan: Planned },
  },
  ({ request }, { plan }) => {
    const build = agent("build", { lane: fork(plan.lane), prompt: tpl("build.md", { plan: plan.plan }) });
    return use(fixUntilGreen, { build, prompt: request });
  },
);
```

```bash
maestro perform repair_from_plan.ts --request "…" --plan 01JC4Q.plan
```

- The port's schema is checked against the recorded instance's outputs before any spend; a missing instance, a non-`ok`
  one or a type mismatch is a usage error.
- Plain values are copied into the new concert's record.
- Artifacts come into the new concert's area by content hash, hard-linked or copied, so pruning the earlier concert
  stays safe.
- Lane versions are fork-only in the new concert.
- A map instance feeds its `results` to a `Settled[]` port, so one name brings a whole fan-out.
- The record notes which earlier instance fed each port.

Rejected: matching, where the new composition re-declares the prefix and each node whose key matches a recorded `ok`
instance takes its result. Its misses are silent and spend, it pairs identical instances by guesswork, and it needs keys
comparable across concerts.

A node reading more than one lane, as a cross-check between builds needs, is backlog 04, not this.
