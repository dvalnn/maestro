# Implementation loop

Status: **trial through wave 3**. At the end of wave 3 the owner keeps, trims or drops each step against the exit
criteria below. Until then it is the default, not a mandate: the conductor may skip a step for a slice where it cannot
pay off, and says why in one line of the slice report.

The port plan's ground rules (section 1), verification (section 5) and brief template (section 6) still hold. This
loop wraps them.

## Steps

1. **Brief** (conductor). Port plan section 6 template, plus an `Out of scope:` line. Done when every deliverable maps
   to a requirement ID or a plan item. Anything else is cut, or raised to the owner as an open question (rule 5).
2. **Implement** (one background subagent, fenced to the slice's package dirs). Sonnet by default, opus for
   contract-setting or design-heavy slices. Done when the acceptance items pass, shown by command output.
3. **Mechanical gate** (conductor). The conductor runs `just check` itself. Anything a linter can check stays in
   Biome, so review spends no tokens on it.
4. **Review** (one fresh read-only subagent, the other model from the implementer). Runs the `code-review` skill from
   the slice's base change. Standards are `CODING_STANDARDS.md`, Spec is the brief, its requirement IDs and the ADRs.
   It also asks, of every changed file:
   - A module, export or dependency that no requirement or plan item asks for (NFR-09)?
   - A duplicate of a helper or pattern the codebase already has?
   - An interface wider than the brief needs?
   - A decision taken in code with no ADR or owner ruling behind it (rule 5)?

   Every finding cites the rule, requirement or ADR it breaks, names `file:line` and states the failure. A finding
   without a citation is dropped.
5. **Triage and fix** (conductor, then the author). Each finding is accepted or rejected with a one-line reason in the
   slice report. At most two fix rounds (rule 9). The conductor then commits one jj change per slice, following
   CLAUDE.md "Commit messages".
6. **Wave review** (one opus read-only subagent, once all of a wave's slices are committed). Reads the wave's combined
   diff against `architecture.md` and the ADRs for what no single slice can show: one concept defined twice, drift at
   the seams between slices, a decision buried in code. Findings follow the citation rule of step 4 and the triage of
   step 5. Fixes land as their own changes.

## Trial log

Each slice report gets a `Loop` table. The wave review writes its row to `docs/reports/wave-<n>-review.md`.

| Step | Findings | Accepted | Changed code or design | Spend[^1] |
| ---- | -------- | -------- | ---------------------- | --------- |

[^1]: Tokens and wall time from the agent's completion notice.

## Exit criteria

At the end of wave 3, drop a step that, over the wave:

- produced no accepted finding that changed code or design,
- had more rejected findings than accepted ones, or
- cost more than its slices' implementers without a catch to match.

If noise is the only problem, try a verification pass first: an agent that tries to refute each finding before triage,
as one opt-in Workflow on contract-setting slices. Ultracode stays off unless a wave has many independent slices and
throughput, not judgment, becomes the bottleneck.
