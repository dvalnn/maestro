# S5. Cache and resume

Status: needs-triage

Slice:        S5 Cache and resume (contract-setting: the cache key, which S6's loader and `prune` build on)
Goal:         A rerun hits the cache and a failed or killed concert resumes at node granularity (CORE-09, NFR-04,
              AC-3 in part).
Read:         requirements.md (CORE-09, CFG-01, NFR-04, AC-3, D-26), architecture.md 7 (Cache, Resume) and 10,
              sdk-spec.md 7 and 13, ADRs 0006, 0007, 0008 (`codeHash`), packages/core/src/perform/ and its record,
              packages/core/src/{host,worker}.ts, packages/testkit, docs/reports/s4/, CODING_STANDARDS.md
Package:      packages/core/src/perform/ and packages/testkit/.
Deliverables:
  1. The cache key (architecture 7): a content hash of the node's definition, its `codeHash` for a code node, its
     input values with each artifact's content hash, and for a cacheable host node its host's config namespace. A
     code node's key holds no config. Perform takes the composed host config as an option for this and stores none
     of it (K38). The stdlib's `codeHash` is its version form (ADR 0008): the in-process worker runs the engine's own
     stdlib, so the version is the installed `@maestro/sdk`'s; the worker-reply version field ADR 0008 names is for
     out-of-process workers and out of scope.
  2. The cache: a table in the record store, `on` or `off` through a perform option that S6 maps to config. Only pure
     code nodes and host nodes whose kind is `cacheable` are stored and looked up; an impure node never is. A hit
     settles the instance `ok` with the stored outputs and runs nothing, and its events say it was a hit. A hit whose
     artifact is gone or no longer matches its hash is a miss. Each entry names the concert that produced it, so S6's
     `prune` drops the entries of the concerts it removes.
  3. Resume (architecture 7): a perform option naming a concert. It keeps the concert's id and runs its stored IR. A
     concert whose process is alive is refused, naming it. The record restarts an existing concert row (today
     `perform` always mints an id and `start` refuses an existing row). Before running an instance, perform reuses that
     concert's recorded `ok` instance with the same key, pure or not; any other recorded outcome runs again. A code
     node's key uses its current `codeHash`, from an injected function the loader (S6) supplies, so a changed node
     and its dependents run again and nothing else does.
  4. The record keeps each `ok` instance's key, and a rerun instance's row is replaced while its earlier events stay.
Acceptance:   With the fake host and fixture functions: a rerun hits the cache for pure nodes and runs impure ones; a
              changed input or `codeHash` reruns exactly the affected node and its dependents; an impure node is never
              cached; a host kind that is not `cacheable` is never cached; a missing or altered artifact is a miss; a
              concert whose process died resumes without repeating an `ok` node, agent-like host nodes included; a
              reject-then-accept host resumes to completion; resuming a live concert is refused; `just check` output.
Out of scope: the loader and how it forms `codeHash` (S6, backlog 08); the CLI's `--resume`, `prune` and the config
              key (S6); cache eviction beyond the concert link; out-of-process workers.
Constraints:  clean break, no domain words, lean (NFR-09), no guessing, no new dependencies. Runs after the wave 3
              follow-up change, which also touches perform.
Open Qs:      Waits on the wave 3 review's K51 (param values in the IR, which resume runs) and K52 (artifact refs
              across concerts, which a cache hit hands on), both logged in .scratch/wave3/morning-calls.md.
              K47. Does a node's definition in the key include its id? A: no, the IR entry without its id and source
              position, so identical pure nodes share hits and a rename keeps them (recommended). B: yes.
              K48. On resume, where do the current code hashes go? A: they replace the stored IR's hashes in the
              record, so `watch` and a later resume see what ran (recommended). B: the stored IR stays as first run,
              and the hashes live only on the instance rows.
Report:       docs/reports/s5/slice-report.md with the Loop table.
