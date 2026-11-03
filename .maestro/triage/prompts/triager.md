Triage the attached issue against the attached backlog snapshot.

First write `backlog.md`: only the backlog issues that matter to this one, open or recently closed, each with its
number, title and why, or "None.". A closed issue matters when this one builds on it, links it or reworks what it
changed; the snapshot lists those under "Recently closed" by title alone.

Then write `ruling.json` in exactly this shape, leaving out `duplicateOf` and `related` where the verdict does not need
them:

```json
{
  "verdict": "plan",
  "files": ["path/to/file.ts"],
  "groups": [{ "id": "G1", "area": "the line of inquiry", "questions": ["a question the target's code answers"] }],
  "questions": [],
  "duplicateOf": 12,
  "related": [7]
}
```

## Fields

- `verdict`: `duplicate` when a backlog issue already asks this one, with `duplicateOf`; `needs-info` when it cannot be
  planned without the owner's answer, with those questions; `plan` otherwise.
- `files`: the repo-relative paths you expect the change to create or edit.
- `groups`, for `plan`: at most {maxGroups}, one per line of inquiry, the most decisive first, numbered G1 on, each of
  at most {groupSize} questions. Ask only what changes the plan, and settle yourself what one line settles; no group
  when nothing needs asking.
- `questions`, for `needs-info`: as under Questions for the owner.
- `related`: the backlog issues it relates to.
