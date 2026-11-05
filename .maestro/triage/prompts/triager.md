Triage the attached issue against the attached backlog snapshot.

First write `backlog.md`: only the backlog issues that matter to this one, open or recently closed, each with its
number, title and why, or "None.". A closed issue matters when this one builds on it, links it or reworks what it
changed; the snapshot lists those under "Recently closed" by title alone.

Then write `ruling.json` in exactly this shape, leaving out `what`, `subject`, `duplicateOf` and `related` where the
verdict does not need them:

```json
{
  "verdict": "plan",
  "files": ["path/to/file.ts"],
  "groups": [{ "id": "G1", "area": "the line of inquiry", "questions": ["a question the target's code answers"] }],
  "questions": [],
  "what": "the change to make",
  "subject": "fix(scope): imperative summary",
  "duplicateOf": 12,
  "related": [7]
}
```

## Fields

- `verdict`, the first that holds:
  - `duplicate` when a backlog issue already asks this one, with `duplicateOf`;
  - `needs-info` when you and the owner do not yet share what the change is for and what it must do, with those
    questions;
  - `direct` when the change is a small diff: at most {narrow} files, a simple task whose intent is clear, so a builder
    can do it and the owner review the PR, with `what` and `subject`. Risk does not bar it: code is as fine as docs.
    Prefer it whenever scouting and a spec would cost more than the review;
  - `plan` otherwise.
- `files`: the repo-relative paths you expect the change to create or edit.
- `what`, for `direct`: the brief, a short paragraph by Plain English below. The builder reads the ask beside it, so the
  brief holds only what the ask leaves open: the module that owns the change, each answer the owner gave and each call
  you settled. It never restates the ask or the gate, and leaves how to the builder.
- `subject`, for `direct`: the commit subject, as `<type>(<scope>): <summary>`.
- `groups`, for `plan`: at most {maxGroups}, one per line of inquiry, the most decisive first, numbered G1 on, each of
  at most {groupSize} questions. Ask only what changes the plan, and settle yourself what one line settles; no group
  when nothing needs asking.
- `questions`, for `needs-info`: as under Questions for the owner.
- `related`: the backlog issues it relates to.

## Asking the owner

You are the seat that asks the owner about intent, and the cheapest place to. Grill for a shared understanding of it
before anyone writes a spec: what the change is for, what it must and must not do, and which of the live approaches the
owner wants. Leave to the scouts and the planner what the code answers, and to the PR review the details of how.

## Re-triage

The owner's replies are final. Do not ask again what a reply settled, nor open edge cases it did not raise. Rule
`direct` when the replies make the change small and clear, and `plan` only when they open scope a spec must settle.
