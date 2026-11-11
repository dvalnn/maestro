---
status: accepted
---

# A check enters the graph as a tool, and a seat earns its place on the bench

A discipline the factory wants kept, such as tests first, no duplicated code or a spec that holds, can sit in the graph
(a code node or a graph-placed seat) or in prose an agent reads. It was placed case by case. Code checks cost little,
and each one either paid or cost nothing. Graph-placed seats carried the whole cost: a mutation hardener ran at about
ten times the price of the build it hardened and fed its findings to no one, and two more seats were removed for cost. A
red gate and a lock check met every condition of the obvious rule (deterministic, cheap, consumed downstream) and were
still dropped for a written rule plus review. Prose aimed at a seat often goes unread: claude lenses never opened a
`writing` attachment that applied, and builders opened `area` once in nine runs.

The rule is:

- **A check and a seat are judged apart.** A check is code; a seat is an agent the graph places.
- **A check enters when it is deterministic and cheap, a consumer acts on its output, and the agent can resolve its
  rejection more cheaply than the review it comes before.** Its default shape is a tool in the seat's `checks`, with the
  node as a backstop. A check a script can always fix, such as formatting, drops the tool and keeps the node.
- **A seat enters or stays when the owner judges its trade worth it on the bench**, across three axes with no formula:
  cost (tokens), time (wall-clock, fix rounds) and quality (findings that get past it to stack or owner review; test
  gaps, duplication and YAGNI cases upheld). This balance may override the check clauses.
- **Prose is placed by scope, then by carrier.** Scope picks the layer that owns it: profile (pack), task (composition)
  or area (workspace). Run-data attachments never carry a discipline. Then the discipline reaches the seat through a
  carrier proven to load it when it applies; until one is proven, it is inline text in its layer. A hint names reference
  material and never carries a rule.

## Considered options

- **One rule for checks and seats: deterministic, cheap, consumed, and replacing agent turns.** It shuts out the tester
  as it adds turns, it can't explain the dropped red gate, and it misses that a seat's cost is in tokens and rounds, not
  in determinism. Rejected.
- **A formula weighing the seat axes.** The axes share no unit, and the bench is too small to fit weights. Rejected: the
  owner calls it from the bench numbers.
- **A check as a node only.** Given to the seat as a tool, a check is cleared before the node fires; as a node alone it
  costs a fix round each time it rejects. Rejected as the default.
- **A discipline as an attachment or hint by default.** Agents skip attachments they are given, depending on the
  harness. Rejected until a carrier is shown to load.

## Consequences

- Every graph-placed seat, the tester included, stays only while the bench bears it out.
- A seat's bounded budget, and keeping partial output on timeout, are host behaviour, outside this rule.
- `CODING_STANDARDS.md` states the rule as review applies it and links here; the bench's procedure is in
  [the bench](../agents/bench.md).
- The layer table under [Prompts](../../packages/host-repo/README.md#prompts) names a carrier once one is proven.
