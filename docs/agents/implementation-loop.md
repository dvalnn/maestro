# Implementation loop

For the conductor and the agents it dispatches: how a slice goes from brief to `main` by hand. The conductor may skip a
step for a slice where it cannot pay off, and says why in one line of the slice report.

## Ground rules

1. **Read first.** `docs/README.md`, the docs map, then the home doc of what the slice touches: `requirements.md`,
   `architecture.md`, `sdk-spec.md`. `GLOSSARY.md` is authoritative for terms.
2. **Domain-free core (CORE-12).** No domain words in `ir`, `core`, `sdk`, `testkit` or `render-text`, which the lint in
   `just check` enforces, nor in `cli` outside its host modules `hosts`, `agent` and `changeset`, and its own tests and
   fixtures (R-10). `cli` may say `run` and `build`.
3. **Lean (NFR-09).** A new node kind, edge kind or SDK primitive needs a written justification in the slice report. The
   default is a code node or a stdlib helper.
4. **Do not guess.** A question the docs settle is derived; anything else goes to the owner ("Owner calls" below). A
   decision with lasting weight gets an ADR with its reason and the alternative rejected.
5. **Evidence.** A slice is done when its acceptance items pass, shown by command output. A claim without output is not
   evidence.
6. **Scope.** A slice changes the packages its brief names. A needed change elsewhere is raised, unless trivial.
7. **IR changes** need an IR version note and updated golden fixtures.
8. **Bounded rework.** At most two fix rounds per slice. A blocker, or a slice still failing after its second round,
   goes to the owner.
9. **No spend in tests.** Core is tested with code nodes and the fake host kind, the host against the stub harness and a
   toy target. A real harness runs only on the owner's go.

## Brief

```
Slice:        <name>
Goal:         <who gets what, and why, in a sentence or two>
Read:         CODING_STANDARDS.md, then the code, tests and docs the slice touches
Deliverables: <each one traced to a requirement ID, an ADR, a ruling or the issue>
Acceptance:   <the tests that pin each deliverable>; `just check` green
Constraints:  <reuse, no new module, ...>
Out of scope: <what a reader might expect and does not get>
Contract:     <the one-way doors it sets, or none>
```

A slice run as the slice composition adds `Leave your changes uncommitted; maestro records the lane.` to Constraints.

## Steps

1. **Brief** (conductor), in the template above. Every deliverable traces to a requirement ID, an ADR, a ruling or its
   issue; anything else is cut, derived or raised (Owner calls).
2. **Implement** (one background subagent, fenced to the slice's package dirs). Done per rule 5. Model and effort follow
   the task's complexity:
   - a mechanical or small fix: sonnet, low effort;
   - an ordinary slice: sonnet, medium effort, or opus, low effort;
   - a contract-setting or design-heavy slice: opus, medium effort;
   - a read-only review slice, such as an API review: high effort.

   Or the slice runs as the slice composition:
   `maestro perform .maestro/slice.ts --preset <tier> --tier <tier> --request <brief> --detach --tour release.<version>`,
   from a checkout at `main` (`packages/cli/README.md`). Its lane splits from `main` (`target.base`); a slice that
   depends on work not yet on `main` sets `-c target.base=<commit>`. Start it detached, never as a session background
   task: a rewind or a session end cancels it. The release's tour lets `ls` list its slices together.

3. **Mechanical gate** (conductor). The conductor runs `just check` itself. Anything a linter can check stays in Biome.
4. **Review** (one fresh read-only subagent, the other model from the implementer, at high effort). Runs the
   `code-review` skill from the slice's base change. Standards are `CODING_STANDARDS.md`, Spec is the brief, its
   requirement IDs and the ADRs. It also asks, of every changed file:
   - A module, export or dependency that no requirement or issue asks for (NFR-09)?
   - A duplicate of a helper or pattern the codebase already has?
   - An interface wider than the brief needs?
   - A decision taken in code with no ADR or owner ruling behind it (rule 4)?

   Every finding cites the rule, requirement or ADR it breaks, names `file:line` and states the failure. A finding
   without a citation is dropped.

5. **Triage and fix** (conductor, then the author). Each finding is accepted or rejected with a one-line reason in the
   slice report. At most two fix rounds (rule 8). The conductor then commits one jj change per slice, following
   CLAUDE.md "Commit messages".
6. **Release review** (one opus read-only subagent, once all of a release's slices are on `main`, before the release is
   cut). Reads the release's combined diff against `architecture.md` and the ADRs for what no single slice can show: one
   concept defined twice, drift at the seams between slices, a decision buried in code. Findings follow steps 4 and 5.
   Accepted findings become issues in the release's milestone, and their fixes land as their own changes.

## Owner calls

A question a brief or a session meets is derived or raised.

- **Derive** when one quotable line decides it (an ADR, a requirement ID, a ruling or a coding-ladder rung) and a worked
  example in `sdk-spec.md` or `architecture.md` agrees. If the text and its purpose disagree, raise the defect.
- **Raise a contract**: anything that cannot change after release without breaking someone, such as an IR field, a CLI
  flag or exit code, a config key, a file layout, an id or path format, or the pack manifest. Batch these, each with a
  default.
- **Always raise a removal**, deferral or narrowing of anything a doc lists or sssf does; YAGNI alone does not clear it.
  A mandated subsystem needs a concrete use case before its details are derived; without one, raise the subsystem.
- **Raise a conflict**: two sources disagree, or the answer would reword a Must requirement or an accepted ADR.
- **Answer an owner's question**, such as "what is the use case?", in full; it is never a call to derive.
- **Raise a fork with a use case**: a concrete example or command, the doc line that is silent, and a recommendation.
- **Report what was derived** in a "Derived, not ruled" table: decision, source, strength (decided or by consistency),
  reversal cost (cheap or contract) and where it landed. A contract-setting slice shows it before dispatch, any other
  slice in its report. Weak derivations come as one list the owner can strike from.

- **A rare edge case** becomes a backlog issue, fixed now only when dead simple.
- **Show a brief before dispatch.**
- **Record no ruling** while the owner is only discussing.
- **Report every auto-mode classifier block**: the tool, the reason label and what was attempted.

## Log

Each slice report gets a `Loop` table. The release review reports its row to the owner with its findings.

| Step | Findings | Accepted | Changed code or design | Spend[^1] |
| ---- | -------- | -------- | ---------------------- | --------- |

[^1]: Model and effort, then tokens and wall time from the agent's completion notice.

The Spend column is the evidence for the effort levels in steps 2 and 4: a release review compares what each level cost
against what it caught, and the owner keeps, shifts or drops a level.

## Revisiting a step

The owner may drop a step that, over a release, produced no accepted finding that changed code or design, had more
rejected findings than accepted ones, or cost more than its slices' implementers without a catch to match. If noise is
the only problem, first try a verification pass: an agent that tries to refute each finding before triage, as one opt-in
Workflow on contract-setting slices. Ultracode stays off unless a release has many independent slices and throughput,
not judgment, becomes the bottleneck.
