Read the attached lessons, reports and backlog. The lessons file has one heading per concert, oldest first, each with
one bullet per lesson. The reports file, when attached, has the same headings, each with one bullet per obstacle an
agent hit or sighting it made; a sighting reads `path · cites · text`, a defect seen outside its task. Then:

- merge lessons, and reports, that say the same thing;
- cluster related ones, lessons and reports together where they share a cause;
- diagnose each cluster, by Diagnosis below;
- propose one change per cluster worth keeping;
- skip a lesson or report that the factory's standing text (CODING_STANDARDS.md, docs/adr/, the justfile, the prompts,
  profiles, compositions and config under .maestro/) or an open or recently closed backlog issue already covers, or that
  only one run would ever need.

A heading that ends in `· read` is a concert an earlier masterclass read. A proposal is kept only when at least one
concert it cites is a heading without that suffix; one that cites no heading's concert, or only read ones, is dropped.
Read concerts still count toward its concerts.

Dropping what the backlog already proposes also covers lessons read again after a pruned masterclass concert.

## Diagnosis

A lesson, an obstacle or a sighting reports one incident, a symptom. Before you propose, read the code, prompts and
config they name, and answer for each cluster:

- Cost: what the failure cost. Drop a failure that a check or a review caught and the agent fixed in the same run.
- Cause: the factory mechanism that should have prevented the failure, and why it did not. Name the mechanism, not the
  incident.
- Class: the other failures that share the cause. Propose the change that removes the class, not this instance.

Prefer, in this order: remove the cause in code or structure; add a check that catches it mechanically; change a prompt.
Propose prompt wording only for an agent's judgment that nothing mechanical can catch. Judge a cluster by its distinct
concerts, not its entries: several from one concert are one incident, so a cluster from one concert needs a cost beyond
its own run.

Give your `masterclass` field in exactly this shape:

```json
{
  "proposals": [
    {
      "target": ".maestro/slice/prompts/_grounds.md",
      "title": "one line",
      "body": "the proposed wording or change, and why",
      "kind": "enhancement",
      "lessons": ["a merged lesson text"],
      "reports": [],
      "concerts": ["c1"]
    }
  ]
}
```

Write each `title` and `body` by Plain English below. The issue shows the target, the lessons and the reports beside the
body, so the body never restates them:

- `title`: the change, one imperative line.
- `body`: the cause in one sentence, then the change, as the wording to add or the edit to make, then why it removes the
  class, in at most two short paragraphs. Never repeat a lesson's or a report's wording.

`kind` is `bug` for a defect the reports show, `enhancement` for a promotion of lessons. `target` is the file the change
lands in, as a path from the repository root, such as `CODING_STANDARDS.md`, a path under `.maestro/` (a prompt, a
profile's instructions, a composition, `config.yaml` with its checks), the `justfile`, a path under `scripts/factory/`
(the tour manager's code), a package's source a sighting names, or `docs/adr/` for a new ADR. The root `CLAUDE.md` is
not one: the factory's agents never read it. `lessons` holds the lesson texts the cluster merges, and `reports` the
obstacle and sighting texts, each as its bullet reads; together they hold at least one. `concerts` holds the id of every
concert whose lessons or reports the cluster merges, each the text before the first `·` in a `## <concert id> · <tour>`
heading, read or not, once. `proposals` may be empty.
