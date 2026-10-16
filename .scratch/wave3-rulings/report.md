# Wave 3 rulings: slice report

Brief: `.scratch/wave3-rulings/spec.md`. The implementer could not write this file, so the conductor saved its report.

## Deliverables

1. **Params leave core and the IR.**
   - IR: `params` is gone from `ir.schema.json`, `src/types.ts`, the four golden fixtures and the README. The 1.0
     changelog says params left before release.
   - SDK: `emit` in `composition.ts` no longer emits the block. `Header` and `paramsSchema` are deleted.
   - Compose: the `params` input, `checkParams`, `paramSubject`, `CFG.params` and the plan's `params` are deleted.
   - With them went `validator()`'s `useDefaults` option in `core/src/ports.ts`, which only params used, and the
     `structuredClone` guards in `checks.ts` and `fold.ts`.
2. **`Host.cacheable` is gone** from `host.ts`, its test, the compose fixtures and testkit. The "cached" wording is gone
   from the doc comments in `worker.ts` and `sdk/src/nodes.ts`.
3. **A rejection can carry outputs.**
   - `reject(reason, outputs?)` and `Rejection<O>` live in `ir/src/code-function.ts`. `CodeFunction` in the SDK types
     the outputs from the node's `out`.
   - `worker.ts` parses them. They are checked against `out` at perform (`finish` in `execute.ts`) and at fold (`offOut`
     in `fold.ts`).
   - They reach a tolerant consumer, a repeat's tolerated state, and a fan-in input as the `Settled` value (`asSettled`
     in `perform.ts`).
4. **Reading an output a rejection did not carry fails.** `unreadable` in `perform.ts` runs after `gate` and fails the
   reader before it starts, naming the upstream and the port.
   - Implicit ports and fan-in edges are exempt.
   - Across repeat iterations it checks the previous member, through `Frame.carried`.
5. **Compose checks host kinds.**
   - `checkHosts` in `checks.ts` reports `HOST.kind`, `HOST.config` and `HOST.ports`.
   - `HOST.ports` compares ports by name and by `mismatch`: the IR's port into the kind's for `in`, the kind's into the
     IR's for `out`.
   - `ownerErrors` reports `TYPE.owner`. A type is owned when it is in `CORE_TYPES` or an installed host's `types`.
   - `finish` checks host outputs on `ok` and on a rejection. `NodeKind.outcomes` is deleted.
6. **Fold honours `timeout`.** `timed` in `worker.ts` is shared by fold's `invoke` (`PURE.timeout`) and perform's
   `execute`, and replaces `timeoutOf`.
7. **Docs.** Both READMEs and the touched doc comments follow. The compose diagnostics table drops `CFG.params` and adds
   `TYPE.owner`, `HOST.config`, `HOST.ports` and `PURE.timeout`.

`Frame.carried` pushed `serial` in `perform.ts` past Biome's limit. Moving its ending into `serialEnding` brings it from
12 to 10.

## Acceptance

| Item                                                                       | Test                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An IR with `params` fails `parseIr`                                        | `ir/src/index.test.ts` "the shape check rejects a params block"                                                                                                        |
| Compose takes no params                                                    | `compose.test.ts` "takes no params, and its plan carries none". On the SDK side, `composition.test.ts` "emits its header and the emitter but not its params"           |
| A tolerant repeat hands rejected findings to the next iteration            | `testkit/src/perform.test.ts` "a code node in a tolerant repeat hands the findings it rejected with…". At fold, `fold.test.ts` "a rejection's outputs are folded…"     |
| Rejection outputs off `out` settle `failed`                                | `perform.test.ts` `rejects-off`, `fold.test.ts` `misdraft` (`TYPE.output`), and at compile time `sdk/src/nodes.test.ts` `@ts-expect-error` on `miscount`               |
| A tolerant reader of a rejection without outputs fails, naming upstream    | `perform.test.ts` "a tolerant reader of a declared output of a rejection without outputs fails before it starts": code `check`, fake host `inspect`, and a repeat case |
| A fan-in input sees a rejected source's value                              | `perform.test.ts` "a fan-in node takes each data input settled, whatever its outcome" (`flawed`)                                                                       |
| Compose reports `HOST.config`, `HOST.ports`, `TYPE.owner`                  | `checks.test.ts` "host nodes": an accept case, four reject cases, and "reject a type no one installed owns"                                                            |
| A fake host's output off `out` settles `failed`                            | `perform.test.ts` `host-off`                                                                                                                                           |
| A never-resolving pure function with a `timeout` fails with `PURE.timeout` | `fold.test.ts` "a fold past the node's timeout stops compose, naming the node and its timeout"                                                                         |

## Review triage

| #   | Finding                                                                                       | Verdict  | Reason                                                     |
| --- | --------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| 1   | `memberOf` drops a rejected map member's outputs from `results`                               | Accepted | Derived from ADR 0006; fixed in round 2                    |
| 2   | `untilHolds` skips the rejected-without-outputs rule, so a tolerant loop runs to its bound    | Accepted | The same read must fail wherever it happens                |
| 3   | A repeat's injected `index` fails the rule when the carried member also declares `index`      | Accepted | Only a port from the member's outputs can be missing       |
| 4   | `HOST.ports` runs after `HOST.config` failed, and a throwing `ports()` then blames the host   | Accepted | The error must name the real cause                         |
| 5   | `markersIn` duplicates ir's schema walker and false-flags markers in `const`/`default` values | Accepted | Reuse the existing walker; it also removes the false flags |
| 6   | A rejection whose `outputs` is not an object gets a misleading error                          | Accepted | The error must point at the real fix                       |
| 7   | `NodeKind` doc comments name their consumers                                                  | Accepted | A doc comment states what its object is, not who calls it  |

## Derived, not ruled

Settled from existing rulings and docs, without an owner call. The owner may overturn any of them.

- **A rejected map member carries a value** (`{ member: outputs }`, as for `ok`) only when every result node of its body
  has outputs. From ADR 0006 and the rule that rejection outputs, when given, are complete. ADR 0006 now says so.
- **Compose reports an unreadable read** (`TYPE.unreadable`) when a node known to start reads a declared output of a
  folded rejection that carried none. From "checked before any spend". It shares `unreadableReason` in
  `core/src/shared.ts` with perform. A read behind an unknown guard is left to perform.
- **A `failed` settlement's outputs stay unchecked.** ADR 0006 leaves a value on `failed` unpinned, and no consumer
  reads one.
- **`TYPE.owner` lists markers through ir's walker** (`schemaMarkers`). From the reuse rule.
- **No `HOST.ports` check after `HOST.config` fails for the same node.** From the error-message rules.

## Loop

| Step      | Findings | Accepted | Changed code or design                           | Spend[^1]       |
| --------- | -------- | -------- | ------------------------------------------------ | --------------- |
| Implement | n/a      | n/a      | deliverables 1–7                                 | 95k tok, 16 min |
| Gate      | 0        | n/a      | none                                             | conductor       |
| Review    | 7        | 7        | code (all 7); design (ADR 0006, `schemaMarkers`) | 58k tok, 4 min  |
| Fix 1     | n/a      | n/a      | findings 2–7                                     | 68k tok, 7 min  |
| Fix 2     | n/a      | n/a      | finding 1, compose-time unreadable read          | 34k tok, 11 min |

[^1]: Tokens and wall time from each agent's completion notice.

## `just check`

After fix round 2, as run by the conductor: Biome, Prettier and `tsc` are clean, and `bun test` gives 634 pass and 0
fail across 30 files.
