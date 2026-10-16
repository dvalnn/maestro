# S5. Resume

Status: ready-for-agent

Slice:        S5 Resume
Goal:         A failed or killed concert resumes at node granularity (CORE-09, NFR-04, AC-3 in part).
Read:         requirements.md (CORE-09, NFR-04, AC-3, D-26), architecture.md 7 (Resume) and 10, sdk-spec.md 7 and 13,
              ADRs 0006, 0007, 0008 (`codeHash`), packages/core/src/perform/ and its record,
              packages/core/src/{host,worker}.ts, packages/testkit, CODING_STANDARDS.md
Package:      packages/core/src/perform/ and packages/testkit/.
Deliverables:
  1. The resume key (architecture 7): a content hash of the node's definition as the stored IR holds it, its current
     `codeHash` for a code node, and its input values with each artifact's content hash. A node's own `config` field
     is part of its definition; composed config is not in the key. The
     stdlib's `codeHash` is its version form (ADR 0008): the in-process worker runs the engine's own stdlib, so the
     version is the installed `@maestro/sdk`'s; the worker-reply version field ADR 0008 names is for out-of-process
     workers and out of scope.
  2. Resume: a perform option naming a concert. It keeps the concert's id and runs its stored IR. A concert whose
     process is alive is refused, naming it. The record restarts an existing concert row (today `perform` always
     mints an id and `start` refuses an existing row). Before running an instance, perform looks up that concert's
     recorded row for the same node id and expansion path, and reuses it when it is `ok` and its key matches, pure or
     not. Any other recorded outcome, or a changed key, runs again. A code node's current `codeHash` comes from an
     injected function the loader (S6) supplies, so a changed node and its dependents run again and nothing else
     does.
  3. On resume, the current code hashes replace the stored IR's in the record, so the stored IR names the code every
     `ok` instance ran under.
  4. The record keeps each `ok` instance's key, and a rerun instance's row is replaced while its earlier events stay.
     A reused instance's events say it was reused.
Acceptance:   With the fake host and fixture functions: a concert whose process died resumes without repeating an `ok`
              node, agent-like host nodes included; a changed input or `codeHash` reruns exactly the affected node and
              its dependents; of three identical instances in a `map`, a resume reruns only the one that did not
              settle `ok`; the stored IR carries the current hashes after a resume; a reject-then-accept host resumes
              to completion; resuming a live concert is refused; `just check` output.
Out of scope: the loader and how it forms `codeHash` (S6, backlog 08); the CLI's `--resume` (S6); reusing another
              concert's results (backlog 12); out-of-process workers.
Constraints:  clean break, no domain words, lean (NFR-09), no new dependencies. Builds on the wave 3 rulings change
              (params and the cache are gone; rejections may carry outputs).
Open Qs:      none; K47, K48, K51, K80 and K81 are ruled in .scratch/wave3/morning-calls.md. Follow "Owner calls" in
              docs/agents/implementation-loop.md: derive what one line settles, raise contracts, removals, conflicts
              and forks to the conductor.
Report:       .scratch/s5-resume/report.md with the Loop table and a "Derived, not ruled" table.
