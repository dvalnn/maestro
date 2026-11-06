# Recover

How to pick a stopped or finished concert back up, and how to clear concerts away.

## Resume

`maestro resume <id>`, after fixing what failed or rejected, reuses each `ok` instance whose inputs and code are
unchanged and performs the rest again. It reapplies the concert's `--preset` and `-c` over the config files as they are
now; its own go on top.

- It finds the record store by today's `dataRoot`: a concert performed with `-c dataRoot=<dir>` needs that `-c` again.
- An error naming a recorded flag is fixed with a `-c` on the resume (`-c <key>=!delete` drops a recorded key), or by
  performing anew.
- It takes no composition, `--tour` or `--title`, and is refused for a running concert (wait or kill it first) or an
  `ok` one (perform anew).
- It runs the graph recorded at first perform, from the pack or file still at its path: an edit adds or removes no node.
  Code nodes load the file as it is now, hashed over the whole bundle (ADR 0008), so any edit reruns every code node,
  with a `warning:` on stderr. After editing a composition, perform a new concert.

## Encore

`maestro encore <id>` performs the composition again as a new linked concert, each agent continuing its counterpart's
session and told what changed, with its param flags (the encore's own override them) and its recorded `-c` under the
encore's own. Every node runs again on fresh lanes.

- The session continued is the same node's at the same keys, a loop's last iteration, unless its seat says
  `encore: false` or it takes a `session`.
- An agent whose counterpart's session is gone or on another harness starts fresh, saying why in `encoreFresh` in
  `ls <id> --json`.
- An encore matching the concert's params, config and target revision is refused: resume instead.

## Kill

`maestro kill <id>` stops a running concert and waits up to 10 s for it to settle `failed` ("the concert was
cancelled"). A concert whose `perform` process died settles `failed` ("process exited") when the record is next read.
Either resumes. A concert that already settled exits 0 and says so on stderr.

## Prune and tours

`maestro prune` deletes concerts with their records and lanes. It selects by id or the filters in `prune --help`, asks
before deleting (`--yes` without a terminal), and takes the lane refs into a pruned concert with it. It refuses a
running concert named by id or `--status running`, and leaves running ones out of a filter.

Give one task's concerts a tour at perform time, so `ls --tour <slug>` finds them (and tours under it, `epic` matching
`epic.story`) and `prune --tour <slug> --yes` clears them. `maestro tour set <slug> <id>...` and
`maestro tour clear <id>...` change it later.
