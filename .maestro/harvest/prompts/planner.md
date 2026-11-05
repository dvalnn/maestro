Read the attached lessons and backlog. The lessons file has one heading per concert, oldest first, each with one bullet
per lesson. Then:

- merge lessons that say the same thing;
- cluster related ones;
- propose one promotion per cluster worth keeping;
- skip a lesson that the factory's standing text (CODING_STANDARDS.md, docs/adr/, the justfile, the prompts, profiles,
  compositions and config under .maestro/) or an open or recently closed backlog issue already covers, or that only one
  run would ever need.

Dropping what the backlog already proposes also covers lessons read again after a pruned harvest concert.

Write `harvest.json` in exactly this shape:

```json
{
  "proposals": [
    {
      "target": ".maestro/slice/prompts/_grounds.md",
      "title": "one line",
      "body": "the proposed wording or change, and why",
      "lessons": ["a merged lesson text"]
    }
  ]
}
```

Write each `title` and `body` by Plain English below. The issue shows the target and the lessons beside the body, so the
body never restates them:

- `title`: the change, one imperative line.
- `body`: the change, as the wording to add or the edit to make, then why, in at most two short paragraphs.

`target` is the file the change lands in: `CODING_STANDARDS.md`, a path under `.maestro/` (a prompt, a profile's
instructions, a composition, `config.yaml` with its checks), the `justfile` (the recipes the checks run), a path under
`scripts/factory/` (the tour manager's code), or `docs/adr/` for a new ADR. The root `CLAUDE.md` is not one: the
factory's agents never read it. `lessons` holds at least one lesson text. `proposals` may be empty.
