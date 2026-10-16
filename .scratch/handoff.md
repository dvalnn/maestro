# Handoff: maestro V1 port, ready for wave 3

Date: 2026-10-15. Read this first, then CLAUDE.md, `docs/port-plan.md` and `docs/agents/implementation-loop.md`.

## 1. State

| Slice                                                       | State                                      | Where                                                                     |
| ----------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| S0 skeleton and spikes                                      | Done. All 5 spikes go on modern Linux x64. | `docs/reports/s0/`                                                        |
| S1 IR                                                       | Done, reviewed, 1 fix round.               | `packages/ir`, ADR 0004, `docs/reports/s1/` (start with `walkthrough.md`) |
| S8a lanes and changesets                                    | Done, reviewed, 1 fix round.               | `packages/host-agents/src/lane`, ADR 0005, `docs/reports/s8a/`            |
| S8b+c sandbox, supervision, harness interface, stub harness | Done, reviewed, 1 fix round.               | `packages/host-agents/src/{sandbox,harness}`, `docs/reports/s8bc/`        |

`just check` passes: Biome, `tsc --noEmit`, 93 tests. Since wave 2: `CODING_STANDARDS.md` (shape, types, comments,
user-facing output), commit message rules in CLAUDE.md, a comment sweep of both packages, clig.dev message fixes, every
open decision ruled, and Biome's cognitive-complexity rule on at 10.

Next is wave 3: S2 (SDK build phase), S3 (compose and plan), S4 (executor, record, events), in parallel, each through
the loop in section 3. In order:

1. Land the shared IR pieces every wave 3 slice builds on: `Outcome`, `Settled` and `worstOutcome` in `packages/ir` (ADR
   0006), and the `x-maestro-type` keyword name, Ajv registration and walker (ADR 0007). Run them as one small
   contract-setting slice through the loop.
2. Write the S2, S3 and S4 briefs, and dispatch them.
3. Once all three are committed, run the wave review (loop step 6), then judge the loop against its exit criteria.

## 2. Owner rulings

Decisions with lasting weight are in ADRs 0003 to 0007. The rest:

- RHEL 8 is best-effort, not a gate (ADR 0003, D-34). Decisions live in `docs/adr/`, not in a `DECISIONS.md`.
- pi's config dir `~/.pi/agent` is mounted read-write in the sandbox for V1 (backlog 01).
- A read-only bind whose source is inside a lane is rejected. S8e host `validate` enforces "inside any lane".
- Read-only git inside lanes, limited to the lane's own ancestry (ADR 0005). Reading other lanes' objects is a known V1
  gap (backlog 04).
- `map.onError` is required, propagate cancels the running siblings, fan-in nodes see `Settled` inputs, and the worst
  outcome wins wherever outcomes collapse (ADR 0006). `repeat` runs at least one iteration. `seq`/`repeat` keep one
  member (deferred).
- Port schemas name artifacts and host types with `x-maestro-type` (ADR 0007).
- The CLI slice owns diagnostic rendering and exit codes (backlog 02). Raw fs and git errors are wrapped when the CLI
  shows them (backlog 03).
- `ALLOW_GIT=1` (the override of `.claude/hooks/deny-git-mutations.py`) is fine for throwaway toy repos, never for the
  maestro checkout.
- Report every auto-mode classifier block to the owner (tool, reason label, what was attempted).

## 3. How the work runs

Each slice runs the loop in `docs/agents/implementation-loop.md`, a trial through wave 3 with its own exit criteria.
Beyond it:

- Agents running in parallel share one working copy. Each brief fences the agent to its own package dirs. Root files
  change only when unavoidable.
- `.claude/settings.json` turns off tool attribution, and a `SessionStart` hook re-injects the loop and this handoff
  after a compaction.
- The remote is SSH, `ssh://git@git.amorimcasa.org:2222/tiago/maestro.git`, like sssf's.

## 4. Machine requirements

bun, node, just, bubblewrap (user namespaces enabled), git 2.40 or newer (lanes use `--attr-source`), python3 (the IR
independent-reader test fails without it), docker (S0 spikes only), pi (S0 spike 4 and S8d). `mise.toml` pins the
toolchain. Run `bun install` on a fresh checkout. Spike build outputs under `.scratch/**/out/` are gitignored; rebuild
them with each spike's `build.sh`.
