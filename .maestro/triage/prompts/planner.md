Triage the attached issue: propose its verdict from the scouts' answers, the triager's ruling, the cut backlog and the
target's code.

Write `plan.json` in exactly this shape, leaving out `spec`, `children` and `related` where the verdict does not need
them:

```json
{
  "verdict": "ready-for-agent",
  "touches": ["path/to/file.ts"],
  "contract": "",
  "questions": [],
  "spec": {
    "what": "the change to make",
    "decisions": [{ "lead": "a title", "points": ["one fact", "In path/to/file.ts"] }],
    "excluded": [{ "lead": "a title", "points": ["one fact"] }],
    "acceptance": ["bun test path/to/file.test.ts"],
    "subject": "feat(scope): imperative summary"
  },
  "children": [{ "title": "a child issue's title", "body": "its ask", "dependsOn": [0] }],
  "related": [7]
}
```

## Fields

- `verdict`: `ready-for-agent` when one change builds the issue as asked, `split` when it needs several, `needs-info`
  when it cannot be specified without an answer.
- `touches`: every repo-relative path the change creates or edits, whatever the verdict; empty when you cannot tell.
- `contract`: the one-way door the change sets or changes, named in a few words, or "" when it sets none. A one-way door
  cannot change after release without breaking a user: an IR field, a public CLI flag or exit code, a key of the user's
  config, an id or path format users type, or the pack manifest. Internal tooling, an environment variable only the tour
  manager reads and a new standalone composition are not.
- `spec`, for `ready-for-agent`: what to change in one paragraph, the decisions the change makes, what it leaves out,
  the shell commands that prove it done, each starting with {runners}, and the commit subject as <type>(<scope>):
  <summary>. The owner approves the spec from its decisions and what it leaves out. Hold the spec to about 3,000 to
  5,000 characters.
- `decisions` and `excluded`: each item a lead and its points. The lead only titles its points; every fact, reference
  and reason belongs in a point, one fact each, and a reference is a plain last point "In <path>". `what` names the
  change, and the facts behind it go in the decisions. A decision is a choice where another option was live, or a fact
  the owner has to approve; leave out calls, statement order and shell lines, which the builder works out. Either list
  may be empty.
- `children`, for `split`: the parts in order, each with the 0-based indexes of the earlier parts it depends on. Split
  only when each part lands and is reviewable on its own; an issue one change can build stays whole, however long.
- `related`: the backlog issues it relates to.
- `questions`: what only the owner can answer. Any question sends the issue to `needs-info` whatever the verdict, so
  settle yourself what the code settles. Ask only what hangs on no other question asked now; a dependent question waits
  for the re-triage. Each is as under Questions for the owner.

## Design

- Codebase health comes before the feature. Before deciding, read the parts of `docs/architecture.md` and
  `CODING_STANDARDS.md` for the packages the change touches. `what` names the module that owns the change; the change
  extends what is there, never a parallel path.
- When the ask can only be met by a shortcut, such as a special case in a shared module, a flag threaded through calls,
  a second route around an existing seam or domain logic in a domain-free package, do not decide it: `split`, the first
  part the refactor the feature needs, when that refactor is clear; `needs-info`, a question naming the clean option and
  its cost, when it is the owner's choice.

## Re-triage

- When the issue carries the spec the last triage proposed, start from it: change what the replies below it ask, and
  keep the rest.
