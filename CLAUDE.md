# Repo

This is maestro. An agentic orchestration engine, cli and software factory enabler. A spiritual successor to
[sssf](../sssf), re-written clean in TS under a symbolic graph paradigm. It's a clean break from the legacy project,
inheriting its strengths and lessons learned while dropping tech debt and providing a clutter free way of moving forward
with new ideas.

## Mission Goals:

1. Implement maestro V1 phase by phase, following the plan under `docs/` plus any ADR additions that come up during
   its implementation. Scope must be kept contained. KISS and YAGNI first -- we don't chase convoluted edge cases nor
   drive-by nice to haves without having a clear reason to do so.
2. Care about the codebase quality all throughout the implementation efforts. If in a weeks time we are chasing the
   same debt `sssf` faced then this mission goal was failed in retrospect. We don't blindly chase feature work and
   quick wins that are damaging to the system architecture or that are specified under muddy/unclear system
   requirements.

## Default coding disposition

Per mission goal #2, avoid overengineering and unnecessary complexity. Ask: "Would a senior engineer say this is
overcomplicated?" If yes, simplify.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? No? Skip it. (YAGNI)
2. Does it already exist in this codebase? Reuse the helper, util, or pattern.
3. Does the standard library do it? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Do it.
7. Only then: write the minimum code that works.

The ladder runs after you understand the problem, not instead of it. Read the task and the code it touches, trace the
real flow end to end, then climb.

Bug fix = root cause, not symptom. A report names a symptom. Before editing, grep every caller of the function you are
about to touch. One guard in the shared function is smaller than one guard per caller, and patching only the path the
ticket names leaves sibling callers broken. Fix it once, where all callers route through.

Rules:

- No unrequested abstractions.
- No avoidable dependencies.
- No speculative scaffolding.
- Prefer deletion over addition.
- Boring over clever.
- Fewest files possible.
- Shortest working diff wins once you understand the problem.
- Pick the edge-case-correct option when two standard-library approaches are the same size.

When not to be lazy:

Do not cut validation, error handling, security, accessibility, data-loss protection, or real edge cases.
Do not skip understanding. A small diff you do not understand is just laziness dressed up as efficiency.
Non-trivial logic leaves one runnable check behind. Trivial one-liners need no test.

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

## Codebase Architecture:

Invoke and follow the `codebase-design` skill when the task at hand impacts the overall project structure. Care for
the codebase. A well built, maintainable system is more important and mission critical, than a system that 'just
works'. Shipping feature 'X' must not compromise maintainability mid to long term. A codebase should improve over time with each
change, not degrade and accumulate tech debt. The codebase is a living system, and we are its caretakers.

## jj

This repo is jj-colocated, and `.claude/hooks/deny-git-mutations.py` denies `git` where jj owns the operation,
answering with the jj that does it. The conventions, and the jj behaviour that surprises, are the `ticket-to-merge`
skill.

## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
