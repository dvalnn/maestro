Write the measurement that shows whether the change in this lane did what it was for. The claims under `## claims` say
what to show, one per line, numbered `P1` on. You write a script; the harness runs it, so the owner reads numbers a run
made, not your word.

Write `.proof/prove.sh`, a POSIX shell script. The harness calls it from the lane as:

```text
sh .proof/prove.sh <base> <head> <out>
```

`<base>` is the repository as it was before the change, at the commit in the `base` file of the attached `changes`.
`<head>` is this lane. Each is a whole tree with its dependencies installed, and neither is a git repository you may
write to. `<out>` is an empty directory.

For each claim, the script writes `<out>/<n>.json`, with `<n>` the claim's number, such as `1.json`:

```json
{
  "result": "Output is 43% to 48% smaller across 6 compositions.",
  "rows": [{ "what": "build_then_review, --json", "before": "190.0 kB", "after": "99.4 kB, 48% smaller" }],
  "ignored": ["2 lines of the header differ"],
  "notCovered": ["compositions outside this repository"],
  "notMeasured": ""
}
```

- `result` is one plain sentence a reviewer reads first, with the number.
- `rows` has at most 6 rows. `what` names the case or thing measured in plain words. `before` is what the base did or
  measured, and `after` what the head did or measured.
- A cell holds one fact in a few words, or one number with its unit, such as `212.9 kB`, `stderr altered` or
  `identical`. Never put several values in a cell, and never use a name the reader would not know.
- `ignored` lists each difference the script left out because the change intends it, with its count. Leave it empty when
  there is none. It holds nothing else.
- `notCovered` lists what the claim reaches and the script did not measure, a few words each. Leave it empty when there
  is none.
- `notMeasured` is only for a claim with no rows: say why in one line. Leave it empty when `rows` has a row.

Rules:

- Measure on the compositions or commands real users run most, never on a pair of small ones. Say in `notCovered` what
  you left out.
- Run each tree's own code to get its side of a measurement: the base's commands in `<base>`, the head's in `<head>`.
- When a claim says two things are the same, compare them with code that is not part of the change. A change must never
  judge itself.
- Print only what the script computed. Never write an expected number in the script.
- The script takes under five minutes, needs no network, and leaves nothing outside `<out>` and the system's temporary
  directory. It may put helper files beside itself in `.proof/`.

Test the script before you finish. Make a base tree yourself, in a temporary directory:

```text
git archive <the base commit> | tar -x -C <dir> && (cd <dir> && bun install --frozen-lockfile)
```

Then run the script on it and on this lane, read each result file, and fix what is wrong or unclear. Read the trees'
`justfile` and READMEs for how to run the code in a tree without installing it.
