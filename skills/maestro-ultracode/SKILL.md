---
name: maestro-ultracode
description: Drive each substantive task through a maestro composition written for it, until "maestro stop".
disable-model-invocation: true
---

# maestro ultracode

Ultracode is on, and the opt-in is standing: for every substantive task this session, write a composition shaped for
that task and perform it as a concert. The goal is the most exhaustive, correct result maestro can produce. Answer
conversational turns and make trivial mechanical edits yourself. The mode ends when the user says "maestro stop" or the
like ("stop maestro", "ultracode off"): say it is off, then work as usual.

Read [the maestro skill](../maestro/SKILL.md) first: its words, exit codes, outcomes and ground rules hold here.

## Per task

1. **Scope inline.** Read the code and the ask until you can name the work list: the items, what each yields, and how
   each is judged done. Done when the list is written down, each item with its judge: a check, a verdict agent or a code
   node.
2. **Find the workspace** by [perform.md](../maestro/perform.md), step 1. Done when compose reports no `CFG.*` or
   `HOST.*` diagnostic.
3. **Shape it.** Pick the shapes below that fit the work list, scaled to the ask: a few agents for a quick task, wide
   fan-outs and three to five verifiers per finding for "thorough" or "audit". A phase whose next step depends on
   reading its result is a concert of its own: plan one concert per phase. Done when every work item has a node that
   does it and a node that judges it.
4. **Write it** at `.maestro/<id>.ts` by [composition.md](../maestro/composition.md). Done when
   `maestro compose .maestro/<id>.ts` exits 0 and the plan's node counts and `repo.agent` bound match the shape.
5. **Rehearse it** as a stub concert by [stub.md](../maestro/stub.md), scripting outputs with `MAESTRO_STUB_OUTPUTS` to
   walk each loop and verdict branch. Done when each rehearsal settles with the outcome you expected.
6. **Give the ceiling**: the plan's `repo.agent` bound and each seat's model, from `compose --plan`. The mode is the
   user's yes to perform; a bound past what the task is worth waits for theirs.
7. **Perform and follow** by [perform.md](../maestro/perform.md), steps 4 and 5, under one `--tour` per task. Done when
   the concert settles.
8. **Read and iterate.** Read the result by [perform.md](../maestro/perform.md), step 6. A `failed` or `rejected`
   concert whose cause you can fix (the composition, a prompt, the config): fix it, then resume, or encore with a
   changed param, by [recover.md](../maestro/recover.md). A finished phase: write the next phase's composition, taking
   the last concert's lane ref as a `Lane` param. Done when every work item is met, or a cause outside your reach blocks
   it.
9. **Report** each concert's outcome, the root cause of any not `ok`, and the final changeset by
   [changesets.md](../maestro/changesets.md). Done when the user has them; applying the changeset waits for their yes.

## Shapes

Each is a pattern over the API in [sdk.md](../maestro/sdk.md); combine them freely, or invent the shape the task calls
for. A shape `@maestro/classics` already has is named with it.

- **Fan out**: `iter.parMap(items, body, { onError: "continue", key })`, one agent per item, each on a `fork` of one
  version. Covers ground one agent's context cannot hold.
- **Repair until green**: `loop.while` over a red check, the repairer continuing the builder's `session` with the
  check's `logs` attached. `repairUntilGreen` is this shape.
- **Adversarial verify**: per finding, several verdict agents prompted to refute it, and a code node keeping what a
  majority upholds. Give the verifiers distinct lenses (correctness, security, does it reproduce) when a finding can
  fail more than one way, and a model family other than the finder's. `panel` is this shape, as lens, skeptic and
  consolidator.
- **Judge panel**: `iter.parMap` over approaches taken from different angles, then a judge seat scoring them and a
  builder grafting the runners-up's best ideas onto the winner. For a wide solution space.
- **Loop until dry**: `loop.doWhile` of a finder whose found items a code node compares with all seen so far, until a
  round finds none new; `max` bounds it.
- **Completeness critic**: a last seat asking what is missing: an item not covered, a claim not verified. What it names
  is the next phase's work list.

Building on `@maestro/classics` needs it set up by [packs.md](../maestro/packs.md), section Building the entry. State in
the report any bound that drops coverage, such as top N or no retry.
