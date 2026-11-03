# Coding standards

The judgement calls code is reviewed against. `just check` enforces everything a linter can; a rule that becomes
mechanical moves into Biome and leaves this file. Source rules, the import graph and domain words among them, are lints
in `just check`, never tests.

## Shape

- Cognitive complexity per function: Biome fails above 10, aim for 6 or less. Bring a function down by extracting a
  named step. A table of callbacks or a flag threaded through calls still counts as its branches.

## Types

- Parse at the boundary. Outside data (JSON, files, subprocess output, env, CLI arguments) is parsed into a known type
  at its entry point, and only that type travels inward. An `as` cast never stands in for the parse.
- Optional and nullable only where absence means something. A field every caller sets is required, and a narrower type
  beats a runtime null check.

## Comments

Contract-only: a comment says what the name and type cannot. That is a contract, invariant, precondition, unit, encoded
format, ownership or lifetime, security assumption, or a pointer to a decision (D-n, ADR).

- `/** */` goes on exports and interface members that carry one of those. Plain data types stay bare.
- `//` inside a body says why: a threat, an ordering constraint, a workaround.
- One or two sentences. A comment that needs a paragraph signals a design to fix or an ADR to point at.
- Tags: `@deprecated <replacement>`, and `@throws` when throwing is part of the contract. A parameter's constraint goes
  in the sentence.
- History, slices and tickets live in jj and the ADRs, so comments describe the code as it is.
- A behaviour change updates or deletes its comment in the same change.

## User-facing output

CLI output, errors, prompts and confirmations follow [clig.dev](https://clig.dev):

- An error says what went wrong and what to do next in one or two lines, with the likely fix last.
- Name the offending path, flag or value exactly as the user would type it.
- Errors go to stderr with a non-zero exit. Primary output goes to stdout, machine-readable where it is meant to be
  piped, with `--json` where structure matters.
- Stack traces and internal jargon appear only in debug output the user asked for.
- Prompt only when stdin is a TTY, and give every prompt a flag that answers it.

## Compositions and prompts

An agent reads five layers, in this order. Each has one home, and no layer restates another's text.

| Layer         | Home                                                   | Holds                                                  | Never holds                             |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------- |
| 1 Frame       | host `frame.ts`                                        | working copy, checks, attachment list, output schema   | a task, a rule of one composition       |
| 2 Profile     | `profiles/<seat>/instructions.md`                      | who the agent is, its method, what it never does       | an attachment name, an output shape     |
| 3 Area        | a preset's `attachments`, e.g. `.maestro/areas/<a>.md` | what is true of one area or run, added to a profile    | the call's task                         |
| 4 Task        | `prompts/<call>.md` and its `_` fragments              | this call: inputs by attachment name, outputs, the bar | who the agent is, what the frame states |
| 5 Attachments | data a code node writes for the call                   | the run's own facts: the issue, the findings           | instructions                            |

Layout:

- The entry stays where the loader looks: `.maestro/<id>.ts`, a pack's `src/index.ts`. A composition's parts live in a
  directory beside it named for it (`.maestro/triage/`, `.maestro/slice/`). A pack stays flat by kind, with one
  `src/prompts/`.
- All prompt text is Markdown in `prompts/`. A task file is named for its call's `label` (`checker.md`); where a call
  picks between texts, each is the label plus a plain suffix (`reviewer-again.md`). A fragment shared by several tasks
  starts with `_` (`_gate.md`, `_questions.md`).
- Only one-line attachment hints, labels, `doc` strings, param descriptions and the owner questions code generates stay
  in TypeScript, at the call.
- Import a prompt with `import X from "./triage/prompts/x.md" with { type: "text" }`. Without the attribute Bun imports
  Markdown as HTML. `md.d.ts` types the import.
- A JSON shape example is a fenced `json` block; its field rules are prose under it. Prettier reflows prompt files to
  120 columns, so unfenced JSON would be wrapped.

Assembly:

- A composition file has one `TASKS` table near its top: each call's task as its prompt file, then the fragments it
  rules by. A fragment joins as a whole paragraph, never spliced into a sentence; a bullet that needs one points to its
  section instead.
- `fill(text, values)` from `@maestro/classics` replaces each `{name}` with a one-line value, and throws when a `{name}`
  has no value or a value has no `{name}`. A branch on a flag stays TypeScript choosing which files to join.

Tests:

- Prompt wording is reviewed as Markdown in the diff, never pinned by substring, unless a parser reads the text.
- Every composition composes, which runs each import and each `fill`; a missing or extra placeholder fails there.
