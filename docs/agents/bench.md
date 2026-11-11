# Replay bench

For the owner and agents judging a change to a factory concert: which five tickets to replay, how, and what the table
shows. Judge a change by this table, not by anecdote.

## Tickets

Five fixed tickets, each replayed fresh as a new concert on its original base and presets, under tour `bench`. Swap one
out only with a note in this doc naming the ticket and why.

| Ticket | Tier     | Catalogue rows[^rows] |
| ------ | -------- | --------------------- |
| #246   | ordinary | 2, 3, 11              |
| #334   | ordinary | 1, 6                  |
| #336   | ordinary | 6, 9                  |
| #360   | ordinary | 1, 12                 |
| #335   | risky    | 1, 5, 6               |

[^rows]:
    Rows of the factory failure catalogue: 1 test gaps found by mutation, 2 fix rounds that hit the cap unresolved, 3
    the same finding raised again, 5 a spec wrong or short against the code, 6 YAGNI edge cases upheld, 9 behaviour
    bugs, 11 the builder rewriting a ruling or the scope, 12 lane and harness friction.

## Stage

One list of tickets; a replay runs the stage the change touches:

- A slice change replays `slice` from the spec recorded on the ticket, at its original tier.
- A triage change replays triage from the ticket first, then `slice` from the new spec.

A ticket's recorded files, kept in one directory for every arm:

- `<ticket>.md`: the request the original slice concert took, or the new spec's request after a triage replay.
- `<ticket>.base`: the commit the original slice concert was cut from.
- `<ticket>.presets`: the presets the original slice concert ran with, one per line.

Record the originals from a ticket's slice concert:

```sh
maestro ls <concert> --json | jq -r .params.request > 246.md
maestro ls <concert> --json | jq -r '.config[] | select(startswith("target.base="))' | cut -d= -f2 > 246.base
maestro ls <concert> --json | jq -r '.presets[]' > 246.presets
```

For a triage change, replay triage on the ticket from the arm's checkout before the slice. The tour keeps it out of the
table, and the triage's spec then rebuilds `246.md` in the shape of the original request:

```sh
maestro perform .maestro/triage.ts --issue "$(cat 246.issue.md)" --backlog <backlog.md> --no-respec \
  --preset triage --tour bench.<arm>.triage --title "bench triage #246 <arm>" -c target.base=$(cat 246.base)
```

`246.issue.md` is the ticket's number, title and body, as the first triage was fed.

## Arms

An arm is one run per ticket under one `.maestro/` setup.

- The baseline is `main`'s `.maestro/`. Record it once per `main` revision and reuse it for every change judged against
  that revision. Name it for the revision, such as `main-54cebcdb`.
- A change's arm is the checkout holding the change. Name it for the change.
- A ticket whose two arms differ by one fix round or less is run again.
- Live history is never a baseline: records from before the resume over-count fix count tokens twice.

## Running an arm

From a checkout holding the arm's `.maestro/`, with the recorded files in `<dir>`:

```sh
bun scripts/bench.ts start <arm> <dir> [<ticket>...] [-- <perform flag>...]
```

It starts the slice concerts detached, each on tour `bench.<arm>.i<ticket>` with its recorded presets and cut at its
recorded base, and prints `#<ticket> <concert id>` for each. With no ticket it starts all five; naming tickets runs just
those again. The arm is one tour segment, so it holds no dot. Flags after `--` go to every `maestro perform`.

```sh
bun scripts/bench.ts table [--json]
```

It prints one row per concert on tour `bench`, the table `maestro ls --tour bench` lists, one row per run, by arm,
ticket, then start. A concert still running shows `-` under `converged`, and so does one with no tester map.

## Metrics

| Column                      | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `arm`, `ticket`, `status`   | The arm, the ticket and how the concert settled          |
| `fixes`                     | Fix rounds the run took                                  |
| `converged`                 | The run's last review upheld nothing                     |
| `pinned`, `deferred`        | Requirements the tester pinned with a test, and deferred |
| `untestable`                | Requirements the tester marked untestable                |
| `in`, `out`                 | Input and output tokens; reasoning counts in `out`       |
| `cache read`, `cache write` | Cache read and cache write tokens                        |
| `time`                      | Wall time                                                |

### Not in the table yet

A column ships with the feature that records it.

- Upheld findings by catalogue row, tagged by an agent pass over each run's `upheld` output.
- The rest of the tester's columns:
  - `pinned` split into firm and best-effort;
  - best-effort tests the builder changed;
  - firm tests the builder corrected as tester mistakes;
  - firm-tier `blocked` runs, each read as a spec flaw or a tester mistake;
  - duplicated or vacuous tests a lens flagged, advisory ones included (catalogue row 7).

## The owner's call

The bench prints the table and the owner decides; there is no threshold. Read only the PR pairs whose numbers disagree
or sit within noise.
