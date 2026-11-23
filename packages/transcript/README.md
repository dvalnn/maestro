# @maestro/transcript

For anyone changing what maestro prints, and for whoever reviews that change. A transcript is a committed text file of
what a terminal shows, held to the code by a test. A change to the output changes the file, so the file's diff in a pull
request is the output before and after. The package is used by tests alone and imports no other package.

| Entry point                   | Gives                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `@maestro/transcript`         | `transcript`, which holds what a test drew to the committed file               |
| `@maestro/transcript/picture` | `picture`, `sectionsOf` and `differing`, which draw colored sections as an SVG |

## The file

A transcript sits beside its test, in `transcripts/<name>.txt`. Its file name is unique across the repo, since a picture
is kept under that name. It holds one section per moment worth showing. A section is a name saying which moment, a rule
that ends at the terminal's edge, then the lines the terminal shows.

```
## watch, 30 columns
─────────────────────────────┐
● fixtures.fanout-fanin-loop
now   ● topics[b] › draft   1
```

The file holds no color, so its diff reads. The test draws with color on, and the color is kept for the picture.

## Writing one

A test draws each section through the code's real entry point and passes them to `transcript(file, sections)`.

- **Show what a user would.** A section is a command, or a view, at a width and a moment a user meets. Name it in those
  words.
- **Few sections.** One per state worth showing. A new column in a table changes every section that shows the table.
- **Nothing that varies.** A section holds no id, time or path that differs between two runs. Give the code a fixed
  clock and fixed ids; never replace them in the text after, since that changes the widths.
- **No real waiting.** A section that needs time to pass moves the clock.

## A transcript or a test

A behaviour is pinned once.

- How one output looks goes in a transcript, and no assertion repeats it.
- A rule that holds for every input, such as every line fitting its terminal at any width, stays an assertion.
- What is not output stays an assertion: an exit code, the record, a signal, a pipe.

When a change touches an output that fragment assertions describe (`toContain` on a row), it moves them into a
transcript section.

## Changing one

After an intended change the test fails. `just transcripts` rewrites every transcript from what the code prints now, or
only those of the test files it is given. Read the file's diff before committing it: it is the claim the pull request
makes.

## Pictures

`just pictures <out>` runs the tests that hold a transcript with their color kept, and draws each transcript as a PNG in
`<out>`. `just pictures <out> <base>` also runs revision `<base>` in a worktree of its own and draws only the sections
that differ, the base's beside this tree's. A section only one side has counts as differing, and so does one whose width
changed. A failing test on this tree is an error; the base's run may fail. A PNG needs `rsvg-convert`; without it the
SVG is left.

The palette is the picture's own. Bold, dim, italic, reverse video and which color a cell takes are the program's.
