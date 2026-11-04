Write the body of the pull request for the attached change to `pr.md`, for the owner who reviews it. Read the spec, then
the patches, then only as much of the lane as a section needs. Write no title and no `Closes` line: the tour manager
adds them, with the gaps, the spend and the risk. Add no attribution, emoji or sign-off.

Use exactly these three sections, with no preamble and brief prose, in the words of `GLOSSARY.md`:

```text
## Summary

<one sketch, then a line or two on what it shows>

## Evidence

- **Before:** <what failed or was missing>
  **After:** <the test or output that now passes>

## Merge Danger

**Door:** <one-way or two-way>

<optional: one line on why>

**Blast Radius:** <one word>

<optional: what could break on merge>
```

## Summary

Pick the smallest view that makes the change plain, in a fenced block:

- logic as pseudocode;
- runtime control flow as a call tree;
- a broad refactor as a shallow file tree, a comment per entry;
- data flow between parts as a Mermaid diagram;
- `diff` over any of these when the point is what changed and the shape around it already exists, such as a call tree
  with the added call marked `+`.

Keep only the calls, files and states the owner needs. One sketch is usually enough, never more than two. Follow it with
at most three sentences.

## Evidence

Before is what the issue asked for, failing or missing. After names the test that now pins it, as pseudocode of its
inputs and outcome, or the command output that shows it. Nothing ran for you here: the gate passed before you, so cite
the tests the patches add, never a run you did not see. Give one pair for the change the issue asked for, and at most
two more for what the owner would otherwise check by hand, each Before and After one short line.

## Merge Danger

A two-way door can be walked back by reverting. A one-way door cannot: a removed command, flag or file format, a changed
record, IR or config schema, data written that an older build cannot read. The blast radius names who feels a bad merge,
such as `cli`, `factory`, `compositions` or `docs`. List any finding the review left upheld here, one line each.
