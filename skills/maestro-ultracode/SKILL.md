---
name: maestro-ultracode
description: Drive each substantive task through a maestro composition written for it, until "maestro stop".
disable-model-invocation: true
---

# maestro ultracode

Ultracode is on, and the opt-in is standing: for every substantive task this session, author a composition shaped for
that task and drive it as a concert. The goal is the most exhaustive, correct result maestro can produce. Answer
conversational turns and make trivial mechanical edits yourself. The mode ends when the user says "maestro stop", or the
like ("stop maestro", "ultracode off"); say it is off, then work as usual.

Read [the maestro skill](../maestro/SKILL.md) first: its words, exit codes and outcomes hold here.

## Per task

1. **Scope inline.** Read the code and the ask until you can name the work list: the items, what each yields, and how
   each is judged done. Done when the list is written down, each item with its judge (a check, a verdict agent, or a
   code node).
2. **Find the workspace.** [running.md](../maestro/running.md), section The loop, step 1. Done when compose reports no
   `CFG.*` or `HOST.*` diagnostic.
3. **Shape it.** Pick the shapes below that fit the work list, scaled to the ask: a few agents for a quick task, wide
   fan-outs and three-to-five-vote verification for "thorough" or "audit". A phase whose next step depends on reading
   its result is a concert of its own: plan one concert per phase. Done when every work item has a node that does it and
   a node that judges it.
4. **Write it** at `.maestro/<id>.ts` by [composition.md](../maestro/composition.md). Done when
   `maestro compose .maestro/<id>.ts` exits 0 and the plan's node counts and `repo.agent` bound match the shape.
5. **Rehearse it** as a stub concert ([running.md](../maestro/running.md), section Stub concerts), scripting outputs to
   walk each loop and verdict branch. Done when each rehearsal settles with the outcome you expected.
6. **Give the ceiling**: the plan's `repo.agent` bound and each seat's model (`compose --plan`). The mode is the user's
   yes to perform; a bound past what the task is worth waits for theirs.
7. **Perform and follow**: [running.md](../maestro/running.md), section The loop, steps 4 and 5, under one `--tour` per
   task.
8. **Read and iterate.** Read the result by The loop, step 6. A `failed` or `rejected` concert whose cause you can fix
   (the composition, a prompt, the config): fix it and `resume`, or `encore` with a changed param. A finished phase:
   write the next phase's composition, taking the last concert's lane ref as a `Lane` param. Done when every work item
   is met, or a cause outside your reach blocks it.
9. **Report**: each concert's outcome, the root cause of any not `ok`, and the final changeset by
   `maestro cs show <id>`. Applying it waits for the user's yes.

## Shapes

Each is a pattern over the API in [composition.md](../maestro/composition.md); compose them freely and invent the shape
the task calls for.

- **Fan out**: `iter.parMap(items, body, { onError: "continue", key })`, one agent per item, each on a `fork` of one
  version. Covers ground one agent's context cannot hold.
- **Repair until green**: `loop.while` over a red check, the repairer continuing the builder's `session` with the
  check's `logs` attached. `repairUntilGreen` in `@maestro/classics` is this loop.
- **Adversarial verify**: per finding, several verdict seats prompted to refute it, a code node keeping what a majority
  upholds. Give the verifiers distinct lenses (correctness, security, does it reproduce) when a finding can fail more
  than one way, and a model family other than the finder's. `panel` in `@maestro/classics` is lens, skeptic and
  consolidator.
- **Judge panel**: `iter.parMap` over approaches taken from different angles, then a judge seat scoring them and a
  builder grafting the runners-up's best ideas onto the winner. For a wide solution space.
- **Loop until dry**: `loop.doWhile` of a finder whose found items a code node compares with all seen so far, until a
  round finds none new; `max` bounds it.
- **Completeness critic**: a last seat asking what is missing: an item not covered, a claim not verified. What it names
  is the next phase's work list.

Building on `panel` or `repairUntilGreen` needs `@maestro/classics` set up by [packs.md](../maestro/packs.md), section
Building the entry. A bound that drops coverage (top N, no retry) is stated in the report.
