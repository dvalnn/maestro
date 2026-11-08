---
name: herdr-demo
description:
  Demo - show the owner a maestro CLI run or an acceptance run live in herdr panes, with `scripts/`. Use when the owner
  asks to see, demo or watch a concert, or to run an acceptance task in herdr.
---

# herdr demo

A toy workspace outside the repo, two herdr panes side by side (left runs `maestro perform`, right runs
`maestro watch`), one `maestro wait` to block until the concert settles. Scripts live in `scripts/`; each prints a
one-line error and fix on failure.

## Safety

- Stub harness by default (`--harness stub --model none`): no spend.
- A real harness (pi with a model) spends money. Run it only on the owner's explicit go for that run, then set
  `MAESTRO_DEMO_GO=1` for `toy.sh`. Never start one unprompted.
- Demo dirs live under `~/Projects/maestro-ac/` (override `MAESTRO_DEMO_ROOT`), never in the repo.
- Never read a `.env` or anything under `~/.claude`.
- Leave the owner's herdr workspaces and their panes alone; touch only the one labelled `maestro-<name>`.
- Never `maestro prune` the owner's record.

## Steps

The release binary `dist/maestro-linux-x64.gz` must exist; if `setup.sh` says it is missing, run `just release`.

1. `scripts/toy.sh <t1|t2> <name> [--harness <h> --model <m>]` makes `<root>/<name>` and prints the perform line.
2. `scripts/setup.sh <name>` writes the release binary to `<root>/bin/maestro`, makes or reuses the herdr workspace
   `maestro-<name>` with two panes whose cwd is the demo dir, and prints `<left> <right>`.
3. `scripts/run.sh <left> <right> <root>/<name> [--timeout <d>] -- <perform args>` takes the perform line from step 1
   after `maestro perform`, plus `--title '<title>'`. It runs perform on the left, waits for `concert <uuid>`, runs
   watch on the right, blocks on `maestro wait`, then prints the right pane's final frame and the left pane's tail. It
   exits with `maestro wait`'s code.

More steps in the same panes: `herdr pane run <pane> '<root>/bin/maestro <args>'` sends a command;
`herdr pane read <pane> --lines N` reads it. Call the binary by that absolute path, never bare `maestro`: the pane's
shell startup puts an installed `maestro` first on PATH, which may be an older build with the same version string. Close
a throwaway demo with `herdr workspace close <id>`.

## Report

Say which harness and model ran, the concert id, the settled state and `maestro wait`'s exit code, and the pane ids.
Quote the right pane's last frame, not the whole transcript. Say plainly when a run was stub.
