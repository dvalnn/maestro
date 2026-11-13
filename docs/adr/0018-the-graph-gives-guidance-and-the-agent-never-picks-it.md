---
status: accepted
---

# The graph gives guidance, and the agent never picks it

A listed skill is guidance the agent reads when it judges it fits. In the skill-read trials claude seats rarely read one
that applied and gpt seats read every one, applied or not; neither placement nor the harness's native `Skill` tool moved
claude, and a read did not predict that the guidance shaped the output. A checklist written into a lens's task caught
every seeded defect, where lenses with skills listed caught a sixth to all of them. With no user mid-concert to invoke
guidance, the graph does. This names the carrier [ADR 0016](0016-a-check-enters-as-a-tool-and-a-seat-earns-its-place.md)
leaves open until proven.

The rule is:

- **Guidance is direct instructions**, in an agent's role (its profile's instructions) or its task. No guidance travels
  as an attachment; an attachment is an artifact the task works on, such as a spec or a diff.
- **A seat carries only what its one job needs.** A builder carries the spec, the task, the project's shapes and the
  test loop, and bets on review to catch the rest; it carries no review checklist. A builder and a tester share one
  testing core, each adding its own part.
- **A profile's instructions are a list of files**, joined in order, so seats of one namespace share a file without
  copying it.
- **A lens rules on a checklist in its task.** A tiered review's code node reads the change and picks the review tier
  and the checklist sections ahead of a panel. Only the review has such a selector; another seat gets one when use asks.
- **The spec carries the project's shapes**: the modules, seams and patterns a change follows. A builder's guidance is
  generic, and the spec is built properly and sized to the task.

## Considered options

- **A listed skill, read when the agent judges it fits**, harness-native skill tools included. Rejected on the trials:
  no wording or placement made claude read reliably, and gpt over-read.
- **Guidance as a must-read attachment.** No run shows an attachment shaping the output; a seat cannot be made to apply
  what it is handed beside the task. Rejected.
- **An oracle agent choosing another agent's guidance.** A judgement call where a code node can pick from the change.
  Rejected.
- **The builder carrying every review item up front.** Rejected: review catches what a lean builder misses, and the
  builder's attention stays on the spec.

## Consequences

- The `skills` profile field, its lookup roots and the frame's `## Skills` section go before a stable release ships
  them; a pack's guidance files stay as the source its instructions are written from.
- A shadow of a pack profile copies the namespace files its instructions list.
- Mid-task injection of guidance between tool calls is deferred, not rejected: both harnesses can host it.
