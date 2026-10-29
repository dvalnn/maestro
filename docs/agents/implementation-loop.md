# Implementation loop

How a slice goes from brief to `main`. The conductor may skip a step for a slice where it cannot pay off, and says why
in one line of the slice report.

## Ground rules

1. **Read first.** `requirements.md`, `architecture.md` and `sdk-spec.md` for what the slice touches. `GLOSSARY.md` is
   authoritative for terms.
2. **Domain-free core (CORE-12).** No domain words in `ir`, `core`, `sdk`, `testkit`, `cli` or `render-text`; the lint
   in `just check` enforces it.
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

1. **Brief** (conductor), in the template above. Done when every deliverable traces to a requirement ID, an ADR, a
   ruling or its issue. Anything else is cut, derived or raised, as "Owner calls" below says.
2. **Implement** (one background subagent, fenced to the slice's package dirs). Done when the acceptance items pass,
   shown by command output. Model and effort follow the task's complexity:
   - a mechanical or small fix: sonnet, low effort;
   - an ordinary slice: sonnet, medium effort, or opus, low effort;
   - a contract-setting or design-heavy slice: opus, medium effort;
   - a read-only review slice, such as an API review: high effort, as in step 4.

   Or the slice runs as the slice composition:
   `maestro perform .maestro/slice.ts --preset <tier> --tier <tier> --request <brief>`, from a checkout at `main`. Its
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
   - A module, export or dependency that no requirement or issue asks for (NFR-09)?
   - A duplicate of a helper or pattern the codebase already has?
   - An interface wider than the brief needs?
   - A decision taken in code with no ADR or owner ruling behind it (rule 5)?

   Every finding cites the rule, requirement or ADR it breaks, names `file:line` and states the failure. A finding
   without a citation is dropped.

5. **Triage and fix** (conductor, then the author). Each finding is accepted or rejected with a one-line reason in the
   slice report. At most two fix rounds (rule 9). The conductor then commits one jj change per slice, following
   CLAUDE.md "Commit messages".
6. **Release review** (one opus read-only subagent, once all of a release's slices are on `main`, before the release is
   cut). Reads the release's combined diff against `architecture.md` and the ADRs for what no single slice can show: one
   concept defined twice, drift at the seams between slices, a decision buried in code. Findings follow the citation
   rule of step 4 and the triage of step 5. Accepted findings become issues in the release's milestone, and their fixes
   land as their own changes.

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

Each slice report gets a `Loop` table. The release review reports its row to the owner with its findings.

| Step | Findings | Accepted | Changed code or design | Spend[^1] |
| ---- | -------- | -------- | ---------------------- | --------- |

[^1]: Model and effort, then tokens and wall time from the agent's completion notice.

The effort levels in steps 2 and 4 are an experiment. The Spend column is its evidence: a release review compares what
each level cost against what its review caught, and the owner keeps, shifts or drops a level from that.

## Revisiting a step

The owner may drop a step that, over a release:

- produced no accepted finding that changed code or design,
- had more rejected findings than accepted ones, or
- cost more than its slices' implementers without a catch to match.

If noise is the only problem, try a verification pass first: an agent that tries to refute each finding before triage,
as one opt-in Workflow on contract-setting slices. Ultracode stays off unless a release has many independent slices and
throughput, not judgment, becomes the bottleneck.
