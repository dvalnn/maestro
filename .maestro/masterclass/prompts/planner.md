Read the attached lessons and backlog. The lessons file has one heading per concert, oldest first, each with one bullet
per lesson. Then:

- merge lessons that say the same thing;
- cluster related ones;
- diagnose each cluster, by Diagnosis below;
- propose one promotion per cluster worth keeping;
- skip a lesson that the factory's standing text (CODING_STANDARDS.md, docs/adr/, the justfile, the prompts, profiles,
  compositions and config under .maestro/) or an open or recently closed backlog issue already covers, or that only one
  run would ever need.

A heading that ends in `· read` is a concert an earlier masterclass read. A proposal is kept only when at least one
concert it cites is a heading without that suffix; one that cites no heading's concert, or only read ones, is dropped.
Read concerts still count toward its concerts.

Dropping what the backlog already proposes also covers lessons read again after a pruned masterclass concert.

## Diagnosis

A lesson reports one incident, a symptom. Before you propose, read the code, prompts and config the lessons name, and
answer for each cluster:

- Cost: what the failure cost. Drop a failure that a check or a review caught and the agent fixed in the same run.
- Cause: the factory mechanism that should have prevented the failure, and why it did not. Name the mechanism, not the
  incident.
- Class: the other failures that share the cause. Propose the change that removes the class, not this instance.

Prefer, in this order: remove the cause in code or structure; add a check that catches it mechanically; change a prompt.
Propose prompt wording only for an agent's judgment that nothing mechanical can catch. Judge a cluster by its distinct
concerts, not its lessons: several lessons from one concert are one incident, so a cluster from one concert needs a cost
beyond its own run.

Write `masterclass.json` in exactly this shape:

```json
{
  "proposals": [
    {
      "target": ".maestro/slice/prompts/_grounds.md",
      "title": "one line",
      "body": "the proposed wording or change, and why",
      "lessons": ["a merged lesson text"],
      "concerts": ["c1"]
    }
  ]
}
```

Write each `title` and `body` by Plain English below. The issue shows the target and the lessons beside the body, so the
body never restates them:

- `title`: the change, one imperative line.
- `body`: the cause in one sentence, then the change, as the wording to add or the edit to make, then why it removes the
  class, in at most two short paragraphs. Never repeat a lesson's wording.

`target` is the file the change lands in: `CODING_STANDARDS.md`, a path under `.maestro/` (a prompt, a profile's
instructions, a composition, `config.yaml` with its checks), the `justfile` (the recipes the checks run), a path under
`scripts/factory/` (the tour manager's code), or `docs/adr/` for a new ADR. The root `CLAUDE.md` is not one: the
factory's agents never read it. `lessons` holds at least one lesson text. `concerts` holds the id of every concert whose
lessons the cluster merges, each the text before the first `·` in a `## <concert id> · <tour>` heading, read or not,
once. `proposals` may be empty.
