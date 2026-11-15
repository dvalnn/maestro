Triage the attached issue: propose its verdict from the scouts' answers, the triager's ruling, the cut backlog and the
target's code.

Give the `plan` reply field in exactly this shape: `spec` only for `ready-for-agent`, `children` only for `split`, and
`related` only when the backlog holds a related issue:

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
    "decisions": [{ "lead": "a title", "points": ["one fact", "In packages/module"] }],
    "consequences": "what the change makes easier or harder, and its cost",
    "excluded": [{ "lead": "a title", "points": ["one fact"] }],
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
- `spec`, for `ready-for-agent`: the doc the owner aligns on and approves, by Altitude below: the need, how the system
  must behave and the architecture it takes. Size each part to the change: a small one gets a sentence or two of
  context, a note per design call and a line of consequences. Its prose, figure notes included, stays within about 3,000
  characters, 5,000 at most, written by Plain English below.
- `what`: the context, a short paragraph or two. It opens with the need as one line, "A `<who>` needs `<what>` so that
  `<why>`.", then why now and the change that meets it, naming the module that owns it. Prose only: a config, code or
  command example goes in a fenced block. The builder reads the ask beside the spec, so `what` never restates it. The
  comment's heading carries the spec's version, so `what` never recounts an earlier one.
- `requirements`: how the system must behave, numbered `R1` on by position. Each holds one behaviour in one EARS
  sentence of at most {maxWords} words, with one `shall` and no condition after it. Write as many as the behaviour
  needs: more short requirements beat fewer long ones. Before you reply, pipe the plan's JSON to `check ears` on
  standard input and settle each requirement it names. A requirement states behaviour a user or operator can observe:
  config accepted or refused, what is staged or run, what a command prints, what is masked. It never names a function, a
  constant, a file or a call order. Cite a `docs/requirements.md` id only where the change touches that requirement.
  - Ubiquitous: `The <system> shall <response>.`
  - Event: `When <trigger>, the <system> shall <response>.`
  - State: `While <state>, the <system> shall <response>.`
  - Unwanted: `If <condition>, then the <system> shall <response>.`
  - Optional: `Where <feature>, the <system> shall <response>.`
- `figures`: the change's shape, drawn before the decisions are written, by Figures below. Leave it out when nothing
  fits.
- `consequences`: a short paragraph or a line: what the change makes easier or harder, and its cost.
- `subject`: the commit subject as `<type>(<scope>): <summary>.`.
- `decisions` and `excluded`: each item a lead and its points. The lead only titles its points; every fact and reason
  belongs in a point, one fact each, and a reference is a plain last point "In `<module>`". A decision is a choice of
  behaviour, architecture or style the owner rules on, where another option was live, that no figure's note already
  states. `excluded` holds only what is out of scope. Either list may be empty.
- `children`, for `split`: the parts in order, each with the 0-based indexes of the earlier parts it depends on. Split
  only when each part lands and is reviewable on its own; an issue one change can build stays whole, however long. Their
  order is drawn from `dependsOn` for you.
- `related`: the backlog issues it relates to.
- `questions`: only in a revision, and for a diagnose group (its area starts with "Diagnose:") whose answer is `unsure`
  or missing from the answers, where you ask at once. Ask what the scout could not establish: the reproduction, or the
  cause once the bug reproduced.

You do not ask the owner, outside a revision or an unsure or unanswered diagnose group: the triager has. Settle what the
ask, the replies and the code leave open with the simplest option that meets the ask, and record it as a decision the
owner approves or redirects.

## Altitude

The spec is for the owner, who rules on intent, scope, behaviour, architecture and style. The builder implements from it
and owns how; the reviewers own standards and edge cases. Stay at the big picture: the need, the behaviour and the
modules and seams the change moves, going lower only where the owner must see a detail to agree on intent. Figure labels
and notes name modules and seams, not functions. Leave out message wording, function and constant names, call order,
test fixtures and which comments or docs change: a spec that dictates them hands the builder a list to copy, and every
such detail is one more claim that can be wrong about the code. When the issue reports a bug, state the wrong behaviour
and the behaviour that must hold, not the fix.

## Design

- Codebase health comes before the feature. Before deciding, read the parts of `docs/architecture.md` and
  `CODING_STANDARDS.md` for the packages the change touches. `what` names the module that owns the change; the change
  extends what is there, never a parallel path.
- The sightings attachment, when given, lists defects and smells earlier runs saw and no masterclass has read yet. Use
  those on the paths the change touches or leans on to see the debt around it.
- When the change leans on, or would add to, a defect in a module it touches, or the ask can only be met by a shortcut,
  such as a special case in a shared module, a flag threaded through calls, a second route around an existing seam or
  domain logic in a domain-free package, neither build on the defect nor take the shortcut: `split`, the first part the
  refactor; or, when that refactor is not clear, take the clean option and name, in a decision, the debt it leaves
  standing.
- A split holds only the refactors the change leans on or would cause. A defect or smell past that fence goes under your
  report's `sightings`, with the rule, doc or behaviour it breaches as its `cites`, never into the spec. A deepening
  candidate is a smell: report it only with the standard or doc it strains, and leave it out when you can cite none.

## Diagnosing a bug

- When a diagnose answer is `grounded`, the spec names the reproducing command and the cause with its `file:line`, and
  states the wrong behaviour and the behaviour that must hold, not the fix.
- When a reply of the owner already answers a diagnose question, spec from that reply and do not ask it again.

## Re-triage

- When the issue carries the spec the last triage proposed, start from it: change what the replies below it ask, and
  keep the rest. A reply is final: do not widen the spec past it.
