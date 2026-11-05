# Domain docs

For anyone working in an area of this repo: how to read and keep current `GLOSSARY.md` and `docs/adr/`.

`GLOSSARY.md` is this repo's `CONTEXT.md`: where a skill says `CONTEXT.md`, use `GLOSSARY.md`, and never create a
`CONTEXT.md`. ADRs are `docs/adr/NNNN-<slug>.md`. A missing file is skipped without comment.

## Before exploring

Read `GLOSSARY.md` and the ADRs that touch the area before exploring it.

## Glossary

- Name concepts by its terms in issues, proposals and test names, never by a synonym an entry rules out.
- A missing concept is a gap to fill with a one-line entry, or invented language to reconsider.
- A rule inside an entry moves to its home in `docs/README.md`.

## ADRs

- Add one when a decision weighed alternatives: the choice, the alternatives rejected and why. A decision with one line
  of why goes in `docs/rulings.md`.
- Output that contradicts an ADR says so (_Contradicts ADR-0007, but worth reopening because…_), never overrides it
  silently.
