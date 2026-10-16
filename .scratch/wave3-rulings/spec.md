# Wave 3 rulings

Status: done

Slice:        Wave 3 rulings (contract-setting: the IR, the code-function contract and the host interface)
Goal:         Land the owner's rulings on the wave 3 review in code, before S5 builds on perform.
Read:         .scratch/wave3/morning-calls.md (K49, K50, K51, K79, K80, and K20 for the port rule),
              requirements.md (CORE-02, CORE-04, CORE-07, CORE-09, CORE-13, D-16, D-17, NFR-02),
              architecture.md 4 to 9, sdk-spec.md 4, 7 and 9, ADRs 0004, 0006, 0007, 0008, packages/ir/README.md,
              packages/core/src/compose/README.md, packages/core/src/{host,worker}.ts, CODING_STANDARDS.md
Package:      packages/ir, packages/sdk, packages/core, packages/testkit. No root files.
Deliverables:
  1. Params leave core and the IR (K51). The IR drops its `params` block: `types.ts`, `ir.schema.json`, the README's
     document table, the golden fixtures and their tests. It stays IR 1.0, since no emitter has shipped; the
     changelog's 1.0 entry says params left before release, as it does for `timeout`. The SDK stops emitting the
     block; params and examples stay on the composition for the CLI and the build. Compose drops its `params` input,
     `checkParams`, `CFG.params` and the plan's `params`. Delete what nothing then uses.
  2. `Host.cacheable` goes (K80): `host.ts`, its test, the compose fixtures and testkit.
  3. A code rejection may carry outputs (K50). `reject(reason, outputs?)` and `Rejection` in ir carry them in a nested
     `outputs` field; the SDK types them from the node's `out`, so `code()` checks them at compile time. When given,
     they are the node's full outputs, checked against `out` like an `ok` node's, a mismatch settling `failed`, at
     perform and at fold alike. They reach a tolerant consumer and a `repeat`'s tolerated state as an `ok` node's do,
     and a fan-in input as the `Settled` value (ADR 0006).
  4. A tolerant consumer that reads a declared output of a rejection that carried none, from a code or a host node,
     settles `failed` before it starts, its reason naming the upstream and the port: "'lint' rejected without
     outputs; its 'findings' cannot be read". The implicit `outcome`, `ok` and `reason` stay readable.
  5. Core checks what a host kind declares (K49). Compose, before any spend, reports:
     - `HOST.config`: a host node's `config` off its kind's `config` schema;
     - `HOST.ports`: a host node whose `in` or `out` in the IR differs from `kind.ports(node)` by port name, or by
       K20's rule (the `x-maestro-type` name and the JSON `type`) on a shared port;
     - `TYPE.owner`: an `x-maestro-type` name that neither core (`CORE_TYPES`) nor an installed host's `types` owns.
     Each names the node or schema path and hints at the fix. Perform checks a host node's outputs against its `out`
     as it does a code node's: on `ok`, and on a rejection that carries outputs. `NodeKind.outcomes` goes.
  6. Folding honours a code node's `timeout` (K79): a fold past it is a `PURE.timeout` compose error naming the node
     and its timeout, and the function is abandoned. No `timeout` means no limit. Fold and perform share the timing
     rule rather than each keeping a copy.
  7. Package READMEs and doc comments follow the changes (`packages/ir/README.md`, the compose README).
Acceptance:   An IR with a `params` block fails `parseIr`; compose takes no params. A code node in a `repeat` with
              `tolerate: "rejected"` that rejects with findings hands them to the next iteration; rejection outputs
              off `out` settle `failed`; a tolerant reader of a rejection without outputs fails naming the upstream,
              for a code and a fake-host source; a fan-in input sees a rejected source's value. Compose reports
              `HOST.config`, `HOST.ports` and `TYPE.owner` on fixture IR with the fake host; a fake host's output off
              `out` settles `failed`. A pure async function that never resolves fails compose with `PURE.timeout`
              when it has a `timeout`. `just check` output.
Out of scope: the resume key and resume (S5); the CLI and param flags (S6); the loader (backlog 08); out-of-process
              workers; a timeout on host kinds (backlog 11); concert fork (backlog 12).
Constraints:  clean break, no domain words in core, lean (NFR-09), no guessing, no new dependencies. Docs never cite
              owner-call ids. Prefer deletion; one helper where two places need one rule.
Open Qs:      none. Anything the rulings leave open is raised to the conductor, not decided in code.
Report:       .scratch/wave3-rulings/report.md with the Loop table.
