Read the attached lessons and backlog. The lessons file has one heading per concert, oldest first, each with one bullet
per lesson. Then:

- merge lessons that say the same thing;
- cluster related ones;
- propose one promotion per cluster worth keeping;
- skip a lesson that the factory's standing text (CODING_STANDARDS.md, docs/adr/, the prompts and profiles under
  .maestro/) or an open or recently closed backlog issue already covers, or that only one run would ever need.

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

`target` is the file the change lands in: `CODING_STANDARDS.md`, a path under `.maestro/` (a prompt, a profile's
instructions, a composition), a path under `scripts/factory/` (the tour manager's code), or `docs/adr/` for a new ADR.
The root `CLAUDE.md` is not one: the factory's agents never read it. `lessons` holds at least one lesson text.
`proposals` may be empty.
