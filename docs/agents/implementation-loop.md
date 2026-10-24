# Implementation loop

Status: **adopted** after its wave 3 trial, every step kept. The conductor may skip a step for a slice where it cannot
pay off, and says why in one line of the slice report.

The port plan's ground rules (section 1), verification (section 5) and brief template (section 6) still hold. This loop
wraps them.

## Steps

1. **Brief** (conductor). Port plan section 6 template, plus an `Out of scope:` line. Done when every deliverable maps
   to a requirement ID or a plan item. Anything else is cut, derived or raised, as "Owner calls" below says.
2. **Implement** (one background subagent, fenced to the slice's package dirs). Done when the acceptance items pass,
   shown by command output. Model and effort follow the task's complexity:
   - a mechanical or small fix: sonnet, low effort;
   - an ordinary slice: sonnet, medium effort, or opus, low effort;
   - a contract-setting or design-heavy slice: opus, medium effort;
   - a read-only review slice, such as an API review: high effort, as in step 4.

   Or the slice runs as the slice composition:
   `maestro perform .maestro/slice.ts --profile <tier> --tier <tier> --request <brief>`, from a checkout at `main`. Its
   lane splits from `main` (`target.base`) by default; a slice that depends on work not yet on `main` forks from that
   work's change instead (`-c target.base=<commit>`). Start it detached from the conductor's session (`setsid -f`, as
   the `maestro` skill's step 4 shows), never as a session background task: a rewind or a session end cancels it. Put it
   on its release's tour, `release.<channel>.<number>` such as `--tour release.beta.6`, so `ls` lists a release's slices
   together.

3. **Mechanical gate** (conductor). The conductor runs `just check` itself. Anything a linter can check stays in Biome,
   so review spends no tokens on it.
4. **Review** (one fresh read-only subagent, the other model from the implementer, at high effort). Runs the
   `code-review` skill from the slice's base change. Standards are `CODING_STANDARDS.md`, Spec is the brief, its
   requirement IDs and the ADRs. It also asks, of every changed file:
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

## Owner calls

A question a brief or a session meets is derived or raised.

- **Derive** when one quotable line decides it (an ADR, a requirement ID, a ruling or a coding-ladder rung) and a worked
  example in `sdk-spec.md` or `architecture.md` agrees. If the text and its purpose disagree, raise the defect.
- **Raise a contract**: anything that cannot change after release without breaking someone, such as an IR field, a CLI
  flag or exit code, a config key, a file layout, an id or path format, or the pack manifest. Batch these, each with a
  default.
- **Always raise a removal**, deferral or narrowing of anything a doc lists or sssf does; YAGNI alone does not clear it.
  A mandated subsystem needs a concrete use case before its details are derived. Without one, raise the subsystem.
- **Raise a conflict**: two sources disagree, or the answer would reword a Must requirement or an accepted ADR.
- **Answer an owner's question**, such as "what is the use case?", in full. It is never a call to derive.
- **Raise a fork with a use case**: a concrete example or command, the doc line that is silent, and a recommendation.
- **Report what was derived** in a "Derived, not ruled" table: decision, source, strength (decided or by consistency),
  reversal cost (cheap or contract) and where it landed. A contract-setting slice shows it before dispatch, any other
  slice in its report. Weak derivations come as one list the owner can strike from.

- **A rare edge case** becomes a backlog issue. Fix it now only when it is dead simple.
- **Show a brief before dispatch.**
- **Record no ruling** while the owner is only discussing.
- **Report every auto-mode classifier block** to the owner: the tool, the reason label and what was attempted.

## Log

Each slice report gets a `Loop` table. The wave review writes its row to `docs/reports/wave-<n>-review.md`.

| Step | Findings | Accepted | Changed code or design | Spend[^1] |
| ---- | -------- | -------- | ---------------------- | --------- |

[^1]: Model and effort, then tokens and wall time from the agent's completion notice.

The effort levels in steps 2 and 4 are an experiment. The Spend column is its evidence: a wave review compares what each
level cost against what its review caught, and the owner keeps, shifts or drops a level from that.

## Revisiting a step

The owner may drop a step that, over a wave:

- produced no accepted finding that changed code or design,
- had more rejected findings than accepted ones, or
- cost more than its slices' implementers without a catch to match.

If noise is the only problem, try a verification pass first: an agent that tries to refute each finding before triage,
as one opt-in Workflow on contract-setting slices. Ultracode stays off unless a wave has many independent slices and
throughput, not judgment, becomes the bottleneck.
