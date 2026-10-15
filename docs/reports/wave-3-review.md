# Wave 3 review

The wave review (loop step 6) read the combined diff `mmwxuwlz..vmuuqusp`: S1b to S1f, S34, S2, S2b, S3 and S4. Its
probes ran SDK-built IR and the real stdlib through compose and perform.

## Loop

| Step        | Findings | Accepted | Changed code or design                                       | Spend[^spend] |
| ----------- | -------- | -------- | ------------------------------------------------------------ | ------------- |
| Wave review | 11       | 11       | yes: the wave 3 follow-up change, owner calls K49 to K52      | 237k, 9.3 min |

[^spend]: Tokens and wall time from the agent's completion notice.

## Triage

Owner calls, logged in `.scratch/wave3/morning-calls.md` under "Open for the owner":

| # | Finding                                                                  | Call |
| - | ------------------------------------------------------------------------ | ---- |
| 1 | Core never reads a host kind's `config`, `outcomes`, `ports` or `types`  | K49  |
| 2 | A code rejection carries no outputs, yet tolerance assumes values flow   | K50  |
| 3 | The IR does not record its param values                                  | K51  |
| 4 | Artifact refs are relative to one concert, the cache spans concerts      | K52  |

Conductor findings, all accepted:

| #  | Finding                                                         | Where it lands                       |
| -- | --------------------------------------------------------------- | ------------------------------------ |
| 5  | Compose folding has its own copy of the worker call             | wave 3 follow-up, deliverable 3      |
| 6  | A missing code export is not a compose error                    | wave 3 follow-up, deliverable 4      |
| 7  | Docs pick `text` from a map member; `MEMBER` is untyped          | wave 3 follow-up, deliverables 6, 10 |
| 8  | The SDK derives map keys its own way                            | wave 3 follow-up, deliverable 6      |
| 9  | No test runs SDK-built IR through core; a `drafts` reducer port | wave 3 follow-up, deliverables 8, 9  |
| 10 | sdk-spec 4.1 contradicts compose and perform                    | wave 3 follow-up, deliverable 10     |
| 11 | The S5 brief lacks config, a reusable concert id, one stdlib version | S5 brief, amended                |

The follow-up brief is `.scratch/wave3-followup/spec.md`; it also carries the known cross-slice duplicates and the
code-node `timeout` (K41).

## Loop exit judgment

Totals over the wave's ten slices, from their Loop tables:

| Step            | Findings | Accepted | Changed code or design | Spend   |
| --------------- | -------- | -------- | ---------------------- | ------- |
| Implement       | n/a      | n/a      | n/a                    | 1,443k  |
| Mechanical gate | 3        | 2[^gate] | yes, in S1f, S3, S4    | conductor |
| Review[^skip]   | 101      | 90       | yes, in every slice    | 1,096k  |
| Fix rounds      | n/a      | n/a      | yes, 13 rounds         | 2,164k  |
| Wave review     | 11       | 11       | yes                    | 237k    |

[^gate]: S1f's gate finding became owner call K23 rather than an accepted fix.
[^skip]: S1d skipped review: a one-function slice.

Against the exit criteria, the conductor's recommendation:

- **Brief.** Keep. Every slice's open questions reached the owner; none was decided in code unnoticed.
- **Implement.** Keep. Opus for contract-setting slices, sonnet for the rest; every slice passed its acceptance.
- **Mechanical gate.** Keep. Near-free, and it caught an undeclared dependency and a stale shape.
- **Review.** Keep. 90 of 101 findings accepted, each slice changed by it, at 76% of implementer spend. Only S1f had
  more rejected than accepted (2 of 6); over the wave the step is far from the noise line, so no verification pass.
- **Fix rounds.** Keep the cap of two. Their spend passes the implementers', but it bought the 90 accepted findings
  and the owner rulings that landed mid-slice, such as K32 to K40 in S4's round 1. Ruling a brief's open questions
  before dispatch, as the S5 and S6 briefs now ask, is the lever on this cost.
- **Wave review.** Keep. 11 of 11 accepted, four contracts no slice owned surfaced, at 16% of implementer spend.

No step meets a drop criterion. Keeping, trimming or dropping each step is the owner's call.
