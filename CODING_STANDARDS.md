# Coding standards

The judgement calls code is reviewed against. `just check` enforces everything a linter can; a rule that becomes
mechanical moves into Biome and leaves this file.

## Shape

- Cognitive complexity per function: Biome fails above 10, aim for 6 or less. Bring a function down by extracting a
  named step. A table of callbacks or a flag threaded through calls still counts as its branches.

## Types

- Parse at the boundary. Outside data (JSON, files, subprocess output, env, CLI arguments) is parsed into a known type
  at its entry point, and only that type travels inward. An `as` cast never stands in for the parse.
- Optional and nullable only where absence means something. A field every caller sets is required, and a narrower
  type beats a runtime null check.

## Comments

Contract-only: a comment says what the name and type cannot. That is a contract, invariant, precondition, unit,
encoded format, ownership or lifetime, security assumption, or a pointer to a decision (D-n, ADR). The reasoning is in
`docs/research/ts-doc-comments.md`.

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
