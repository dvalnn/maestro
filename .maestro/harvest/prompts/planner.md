Read the attached lessons and backlog. The lessons file has one heading per concert, oldest first, each with one bullet
per lesson. Then:

- merge lessons that say the same thing;
- cluster related ones;
- propose one promotion per cluster worth keeping;
- skip a lesson that the standing text (CLAUDE.md, CODING_STANDARDS.md, the profiles' instructions.md, docs/adr/) or an
  open or recently closed backlog issue already covers, or that only one run would ever need.

Dropping what the backlog already proposes also covers lessons read again after a pruned harvest concert.

Write `harvest.json` in exactly this shape:

```json
{
  "proposals": [
    {
      "target": "CODING_STANDARDS.md",
      "title": "one line",
      "body": "the proposed wording and why",
      "lessons": ["a merged lesson text"]
    }
  ]
}
```

`target` is one of `CLAUDE.md`, `CODING_STANDARDS.md`, `.maestro/profiles/<name>/instructions.md`, or `docs/adr/` for a
new ADR. `lessons` holds at least one lesson text. `proposals` may be empty.
