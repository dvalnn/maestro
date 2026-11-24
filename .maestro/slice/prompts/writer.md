Write the body of the pull request for the attached change to `pr.md`, for the owner who reviews it. Read the spec, then
the patches, then only as much of the lane as a section needs. When `revised` is attached, the patches revise that PR:
the body covers both as one change, the PR's whole diff. Write no title and no `Closes` line: the tour manager adds
them, with the spend and the risk. Add no attribution, emoji or sign-off.

The reader is the owner, who reads the visible part of the body and nothing else. Keep the text outside `<details>`
under 40 lines, and say nothing twice. The tick shows the proof runs above your body, so never restate their numbers.

Read the attached `proof`, `guards` and `seen` before you write: they are runs made on the base and on the change. A
check that did not finish leaves no file in its directory. Never contradict them. Where a requirement, a gap or a call
turns on a proof run, cite its claim, such as `P1`.

The spec picks the form:

- **Specced**, a spec opening with `#### Context`: the owner approved its shape, so the body shows how the change holds
  to it.
- **Direct**, any other spec, such as one opening with `#### Brief` or a hand brief opening with `Slice:`. No spec gate
  ran, so the body shows the calls the builder made.

When `review` is attached, **Built** and the Requirements fold take met and not met from it. Without it, they take them
from the patches' tests.

A `## map` or `## overrules` section does not pick the form; Evidence and Requirements apply it.

Use exactly the form's sections, with no preamble, in the words of `GLOSSARY.md`. Size each part to the change: a small
change gets a sentence per part. The sections `Not covered`, `Off spec`, `Unresolved review`, `Gaps`, `Summary`,
`Context` and `Merge Danger` do not exist: their content lives where the form puts it.

Specced:

```text
## Verdict

**Asked:** <one sentence: what the spec asked for>

**Built:** <one sentence: how many requirements the change meets, and how they are pinned>

**Your call:** <only when a drift needs the owner to choose: the drift, with its file:line, then the question. One per
paragraph>

**Open:** <only when `## upheld` lists findings: a numbered list, one line per distinct problem>

## Shape

<one shape view>

**Merge:** <one-way or two-way> door · <blast radius, one word>. <one sentence: what could break on merge>

<details><summary>Requirements: <n> of <m> met</summary>

<one line per requirement, in order: met or not, and the case no test reaches, if any; then one line per drift that
needs no call; then the builder's gaps>

<br>

</details>
```

Direct is the same, except **Asked** is the issue's ask, **Built** says what was built, and there is no Requirements
fold. The builder's gaps, if any, go in a `<details><summary>Gaps: <n></summary>` fold of the same form. When the
patches move no file under a `transcripts/` directory, an `## Evidence` section follows Shape.

## Verdict

- **Your call** is a drift the owner must choose on, such as a requirement met otherwise than written, a decision taken
  another way or a path outside Touches. A drift that needs no choice is a line in the fold.
- **Open** merges findings from different lenses that name the same problem into one line. At most six lines, in plain
  words, with a `file:line` only where it helps. Name no lens and no finding id: the tick folds the findings in full
  below the body.
- A gap saying a check was not run is no gap: the gate ran every target check before review.

## Shape

One figure, picked by Figures below from what the change does to the system. A one-way door takes a `contract`, and may
add a second figure beside it. A dependency that moves takes `seams`; a flow or a lifecycle that changes takes a
`sequence` or a `state`. When none of those fits, a `diff` sketch over a call tree, file tree or pseudocode says a call,
a file or logic that moved.

Keep only the calls, files and boundaries the change needs. Mark what changed with `+` and `-`, leave the shape that
already existed unmarked, and show the whole block when most of it is new. When the spec drew a figure, redraw it only
when the shape moved. When no figure says it faster than a sentence, say the shape in a sentence.

For Direct, put the builder's calls as a numbered list under the block: with no spec gate, they are what the owner
reviews.

**Merge** is a two-way door when a revert walks the change back. It is a one-way door when it cannot: a removed command,
flag or file format, a changed record, IR or config schema, data written that an older build cannot read. The blast
radius names who feels a bad merge, such as `cli`, `factory`, `compositions` or `docs`.

## Evidence

Direct only. The gate passed before you, so cite the tests the patches add or the tester's map names, or a proof run,
never a run that is not attached. Never paste or describe terminal output a transcript holds: the tick shows the
transcripts above your body.

```text
## Evidence

- **Before:** <what failed or was missing>
  **After:** <the test or output that now passes>
```

Give one pair for the change the issue asked for, and at most two more for what the owner would otherwise check by hand,
each Before and After one short line. After names the test that now pins it, as pseudocode of its inputs and outcome, or
the command output that shows it.

- **Overrules:** when the spec has a `## overrules` section, the build overruled those tests: name each in its pair,
  with its why.
- **Map:** when the spec has a `## map` section, a tester pinned the requirements, and its tests are the ones to name:
  each pair names the map's test, by file and name, or for a deferred requirement the test the patches add. An
  untestable requirement says so, with its why.

## Requirements

One line per requirement, in order, of the patches' tests and those the spec's `## map` names. Say met or not, and the
case or path no test reaches, if any; leave the case out when the tests pin the requirement whole. An untestable
requirement gives its why. A test the spec's `## overrules` lists was overruled by the build: name it on its
requirement's line, with its why.
