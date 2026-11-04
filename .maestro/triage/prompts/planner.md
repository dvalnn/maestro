Triage the attached issue: propose its verdict from the scouts' answers, the triager's ruling, the cut backlog and the
target's code.

Write `plan.json` in exactly this shape, leaving out `spec`, `children` and `related` where the verdict does not need
them:

```json
{
  "verdict": "ready-for-agent",
  "touches": ["path/to/file.ts"],
  "contract": "",
  "spec": {
    "what": "the problem, why now and the change that meets it",
    "requirements": ["When <trigger>, the <system> shall <response>."],
    "figures": [
      { "kind": "seams", "caption": "Red: an edge that goes.", "source": "flowchart LR ...", "notes": ["one fact"] }
    ],
    "decisions": [{ "lead": "a title", "points": ["one fact", "In path/to/file.ts"] }],
    "consequences": "what the change makes easier or harder, and its cost",
    "excluded": [{ "lead": "a title", "points": ["one fact"] }],
    "acceptance": ["bun test ./path/to/file.test.ts # R1"],
    "subject": "feat(scope): imperative summary"
  },
  "children": [{ "title": "a child issue's title", "body": "its ask", "dependsOn": [0] }],
  "related": [7]
}
```

## Fields

- `verdict`: `ready-for-agent` when one change builds the issue as asked, `split` when it needs several.
- `touches`: every repo-relative path the change creates or edits, whatever the verdict; empty when you cannot tell.
- `contract`: the one-way door the change sets or changes, named in a few words, or "" when it sets none. A one-way door
  cannot change after release without breaking a user: an IR field, a public CLI flag or exit code, a key of the user's
  config, an id or path format users type, or the pack manifest. Internal tooling, an environment variable only the tour
  manager reads and a new standalone composition are not.
- `spec`, for `ready-for-agent`: an engineering doc the owner approves, read by the builder and the reviewers after. It
  sets the idea and the intent; how to build it and its corner cases are theirs. Size each part to the change: a small
  one gets a sentence or two of context, a requirement or two, a note per design call and a line of consequences. Its
  prose stays within about 3,000 characters, 5,000 at most, figure source aside.
- `what`: the context, a short paragraph or two: the problem, why now, and the change that meets it, naming the module
  that owns it.
- `requirements`: what the change must do, at the level of intent, each one sentence in an EARS pattern, numbered `R1`
  on by position. Cite a `docs/requirements.md` id only where the change touches that requirement.
  - Ubiquitous: `The <system> shall <response>.`
  - Event: `When <trigger>, the <system> shall <response>.`
  - State: `While <state>, the <system> shall <response>.`
  - Unwanted: `If <condition>, then the <system> shall <response>.`
  - Optional: `Where <feature>, the <system> shall <response>.`
- `figures`: the change's shape, drawn before the decisions are written, by Figures below. Leave it out when nothing
  fits.
- `consequences`: a short paragraph or a line: what the change makes easier or harder, and its cost.
- `acceptance`: the shell commands that prove it done, each starting with {runners} and ending in a shell comment naming
  the requirements it proves (`# R1, R2`); every requirement is proved by one. A `bun test` path starts with `./`:
  without it bun reads a name filter, which skips dot directories such as `.maestro`.
- `subject`: the commit subject as <type>(<scope>): <summary>.
- `decisions` and `excluded`: each item a lead and its points. The lead only titles its points; every fact, reference
  and reason belongs in a point, one fact each, and a reference is a plain last point "In <path>". A decision is a
  choice where another option was live, or a fact the owner has to approve, that no figure's note already states; leave
  out calls, statement order and shell lines, which the builder works out. Either list may be empty.
- `children`, for `split`: the parts in order, each with the 0-based indexes of the earlier parts it depends on. Split
  only when each part lands and is reviewable on its own; an issue one change can build stays whole, however long. Their
  order is drawn from `dependsOn` for you.
- `related`: the backlog issues it relates to.

You do not ask the owner: the triager has. Settle what the ask, the replies and the code leave open with the simplest
option that meets the ask, and record it as a decision the owner approves or redirects.

## Design

- Codebase health comes before the feature. Before deciding, read the parts of `docs/architecture.md` and
  `CODING_STANDARDS.md` for the packages the change touches. `what` names the module that owns the change; the change
  extends what is there, never a parallel path.
- When the ask can only be met by a shortcut, such as a special case in a shared module, a flag threaded through calls,
  a second route around an existing seam or domain logic in a domain-free package, do not take it: `split`, the first
  part the refactor the feature needs; or, when that refactor is not clear, take the clean option and name its cost in a
  decision.

## Re-triage

- When the issue carries the spec the last triage proposed, start from it: change what the replies below it ask, and
  keep the rest. A reply is final: do not widen the spec past it.
