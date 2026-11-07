Write the body of the pull request for the attached change to `pr.md`, for the owner who reviews it. Read the spec, then
the patches, then only as much of the lane as a section needs. Write no title and no `Closes` line: the tour manager
adds them, with the gaps, the spend and the risk. Add no attribution, emoji or sign-off.

The spec picks the form:

- **Direct**, a spec with no `#### Requirements`: no spec gate ran, so the body shows the calls the builder made.
- **Specced**, a spec with `#### Requirements`: the owner approved its shape, so the body shows how the change holds to
  it.

Use exactly the form's sections, with no preamble, in the words of `GLOSSARY.md`. Size each section to the change: a
small change gets a sentence per section.

Direct:

```text
## Context

<a sentence or two: the problem and the intent>

## Shape

<one figure, footnoted with the calls the builder made>

## Evidence

- **Before:** <what failed or was missing>
  **After:** <the test or output that now passes>

## Merge Danger

<door and blast radius>
```

Specced:

```text
## Summary

<one line: built to spec, shape unchanged or not>

## Evidence

| Requirement | Pinned by |
| ----------- | --------- |
| R1          | <test>    |

## Off spec

<one line per drift, or "None.">

## Merge Danger

<door and blast radius>
```

## Shape

Draw the change by Figures below: the caption when it has one, the fenced source, then its notes as a numbered list. The
notes are the builder's own calls, read from the patches; with no spec gate, they are what the owner reviews. When no
figure fits, say the shape in a sentence.

## Evidence

Nothing ran for you here: the gate passed before you, so cite the tests the patches add or the spec's acceptance names,
never a run you did not see.

- **Direct:** Before is what the issue asked for, failing or missing. After names the test that now pins it, as
  pseudocode of its inputs and outcome, or the command output that shows it. Give one pair for the change the issue
  asked for, and at most two more for what the owner would otherwise check by hand, each Before and After one short
  line.
- **Specced:** one row per requirement, in order, naming the test that pins it: the acceptance item whose `# R` comment
  names it, or a test the patches add. A requirement no test pins says so in its row.

## Off spec

A drift is where the change departs from the approved spec: a requirement met otherwise than written, a decision taken
another way, a path outside Touches, a figure the patches no longer match. Give each one line. Redraw a spec figure, by
Figures below, only when the shape moved.

## Merge Danger

Use exactly:

```text
**Door:** <one-way or two-way>

<optional: one line on why>

**Blast Radius:** <one word>

<optional: what could break on merge>
```

A two-way door can be walked back by reverting. A one-way door cannot: a removed command, flag or file format, a changed
record, IR or config schema, data written that an older build cannot read. The blast radius names who feels a bad merge,
such as `cli`, `factory`, `compositions` or `docs`.
