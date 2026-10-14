# Handoff: maestro V1 port, after wave 2

Date: 2026-10-14. Written for a fresh session on a new machine. Read this first, then CLAUDE.md and
`docs/port-plan.md`.

## 1. State

| Slice | State | Where |
| ----- | ----- | ----- |
| S0 skeleton and spikes | Done, committed. All 5 spikes go on modern Linux x64. | `docs/reports/s0/` |
| S1 IR | Done, reviewed, 1 fix round. | `packages/ir`, ADR 0004, `docs/reports/s1/` (start with `walkthrough.md`) |
| S8a lanes and changesets | Done, reviewed, 1 fix round. Read-only git in lanes added by owner ruling. | `packages/host-agents/src/lane`, ADR 0005, `docs/reports/s8a/` |
| S8b+c sandbox, supervision, harness interface, stub harness | Done, reviewed, 1 fix round. | `packages/host-agents/src/{sandbox,harness}`, `docs/reports/s8bc/` |

`just check` passes: Biome, `tsc --noEmit`, 86 tests. Each slice report holds evidence, decisions and follow-ups for
later slices.

Next is wave 3: S2 (SDK build phase), S3 (compose and plan), S4 (executor, record, events), in parallel. Q2 must be
ruled before S2 starts. Q4 to Q7 should be ruled before wave 3 too.

## 2. Open decisions for the owner

| Code | Decision | Recommendation | Detail |
| ---- | -------- | -------------- | ------ |
| Q2 | Default `map.onError` | Propagate. Fix `architecture.md` line 176. | `docs/reports/s1/walkthrough.md` section 8 |
| Q3 | Any lane can read every lane's sealed versions via `git cat-file --batch-all-objects` on the shared store objects. Keep as a known V1 gap, or give each lane only its own objects? | Known V1 gap, logged to backlog. ADR 0005 now says "accepted provisionally, owner ruling pending". | ADR 0005, "What an agent can discover" |
| Q4 | Fan-in over non-ok inputs (`firstOk`) | Optional "deliver as Settled" marker on data edges (minor IR bump) | walkthrough section 8 |
| Q5 | Outcome of a multi-result map member | Worst outcome wins | walkthrough section 8 |
| Q6 | `repeat` `until` on the initial state | No, at least one iteration | walkthrough section 8 |
| Q7 | Marking artifacts and host types in port schemas | `x-maestro-type` JSON Schema annotation | walkthrough section 8 |
| Q8 | Several members on `seq`/`repeat` | Defer | walkthrough section 8 |
| D1 | Doc comment convention | Contract-only (rules in section 4) | `docs/research/ts-doc-comments.md` |
| D2 | Where the convention lives | A short subsection in CLAUDE.md "Default coding disposition" | |
| D3 | Clean wave 2 code to the convention now, or as it is touched | Owner's call | |

## 3. Owner rulings made so far (not all are in ADRs yet)

- RHEL 8 is best-effort, not a gate. Maestro builds with modern tooling (ADR 0003, D-34).
- Decisions live in `docs/adr/`, not in a `DECISIONS.md` (port plan rule 5 amended).
- pi's config dir `~/.pi/agent` is mounted read-write in the sandbox for V1, as sssf does. Known defect, backlog 01.
- A read-only bind whose source is inside a lane is rejected. The sandbox guards its own lane. S8e host `validate`
  enforces "inside any lane" (follow-up in the S8b+c report).
- Read-only git inside lanes, limited to the lane's own ancestry (ADR 0005).
- `ALLOW_GIT=1` (the override of `.claude/hooks/deny-git-mutations.py`) is fine for throwaway toy repos, never for the
  maestro checkout.
- Report every auto-mode classifier block to the owner (tool, reason label, what was attempted). The owner may add
  allow-lists to the project settings.

## 4. Doc comment convention (proposed, D1)

From `docs/research/ts-doc-comments.md`, condensed:

1. Comment only what the name and type cannot say: contract, invariant, precondition, units, encoded format,
   ownership or lifetime, security assumption, or a pointer to a decision (D-n, ADR).
2. `/** */` on exports and interface members when rule 1 applies. `//` inside bodies only for why: a threat, an ordering
   constraint, a workaround. Never for what.
3. One or two sentences. If it needs a paragraph, fix the design or point at the ADR.
4. No tags, except `@deprecated <replacement>`, and `@throws` when throwing is part of the contract.
5. Never restate the name, narrate the next line, record history, or cite slices or tickets.
6. Change or delete a comment in the same change that changes the behaviour.

Enforced by one line in the code-review standards checklist, not a lint rule.

## 5. How the work runs

- The main session orchestrates and owns the mission goals. Work is delegated to background agents: sonnet by
  default, opus for contract-setting or design-heavy slices (S1 and S8a ran on opus).
- Each slice gets a brief in `.scratch/<slice>/spec.md` (port plan section 6 template), one implementing agent, then
  an independent read-only review agent, then at most two fix rounds by the original author (port plan rule 9).
- Agents running in parallel share one working copy. Each brief fences the agent to its own package dirs. Root files
  (`package.json`, `bun.lock`, `tsconfig.json`, `biome.json`, `justfile`) change only when unavoidable.
- The orchestrator verifies `just check` itself and commits one jj change per slice. No Co-Authored-By line (the
  owner's output style forbids it).
- Agent launches were blocked several times by the auto-mode classifier ("Auto-Mode Bypass", "Data Exfiltration").
  They ran after leaving auto mode.

## 6. Machine requirements

bun, node, just, bubblewrap (user namespaces enabled), git 2.40 or newer (lanes use `--attr-source`), python3 (the IR
independent-reader test fails without it), docker (S0 spikes only), pi (S0 spike 4 and S8d). `mise.toml` pins the
toolchain. Spike build outputs under `.scratch/**/out/` are gitignored. Rebuild them with each spike's `build.sh`.
