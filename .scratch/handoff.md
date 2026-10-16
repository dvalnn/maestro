# Handoff: maestro V1 port, S6c in flight

Date: 2026-10-17. Read this first, then CLAUDE.md, `docs/port-plan.md` and `docs/agents/implementation-loop.md`.

## 1. State

Slices S0 to S6b are done and committed; S1, S2 to S4, S5 and S6a/b each went through the loop. Wave reviews:
`docs/reports/wave-3-review.md` and `wave-4-review.md`.

| Change     | What                                         | Pushed |
| ---------- | -------------------------------------------- | ------ |
| `vtynstqn` | docs: rule the S6 config and CLI calls       | yes    |
| `ywtnwnll` | S6a: packs, files and IR with layered config | no     |
| `wnwnnlmn` | S6b: the maestro verbs                       | no     |
| `xprmyywx` | docs: drop node purity, rule K104 to K110    | no     |

In flight: **S6c** (`.scratch/s6c-fixes/spec.md`, opus implementer): drop node purity and compose-time folding (K108,
ADR 0009), bare files take no YAML (K104), `perform` and `wait` print the result's outputs (K105), `BUILD.*` codes
(K109), map key functions only at perform (K110), and the wave 4 code findings. Then: gate, sonnet review, triage, one
jj change.

Next after S6c: **S7 core gate**, which needs the owner's written go (port plan S7). Push only when the owner asks.

## 2. Owner rulings

Decisions with lasting weight are in ADRs 0001 to 0009. Every K-numbered ruling is in `.scratch/wave3/morning-calls.md`.
Standing stances:

- Hand-written IR is the golden fixtures' exercise of IR-01. Don't chase edge cases only hand-written IR can express.
- Rare edge cases are YAGNI: write them as backlog (`.scratch/backlog/issues/`), and fix one now only if dead simple.
- `ALLOW_GIT=1` is fine for throwaway toy repos, never for the maestro checkout; use jj.
- Report every auto-mode classifier block to the owner (tool, reason label, what was attempted).
- Show a brief before dispatch; when the owner is only discussing, record no ruling.

## 3. How the work runs

Each slice runs the loop in `docs/agents/implementation-loop.md`. Beyond it:

- Agents running in parallel share one working copy. Each brief fences the agent to its own package dirs.
- `.claude/settings.json` turns off tool attribution, and a `SessionStart` hook re-injects the loop and this handoff
  after a compaction.
- The remote is SSH, `ssh://git@git.amorimcasa.org:2222/tiago/maestro.git`.
- A CLI demo lives in the session scratchpad (`maestro-demo/`, run in herdr pane `wB:p1`); re-create it from
  `packages/cli/README.md` if the scratchpad is gone.

## 4. Machine requirements

bun, node, just, bubblewrap (user namespaces enabled), git 2.40 or newer (lanes use `--attr-source`), python3 (the IR
independent-reader test fails without it), docker (S0 spikes only), pi (S0 spike 4 and S8d). `mise.toml` pins the
toolchain. Run `bun install` on a fresh checkout.
