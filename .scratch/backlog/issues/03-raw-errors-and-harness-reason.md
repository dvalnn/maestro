# Raw fs and git errors reach the user without context

Status: needs-triage

- `packages/host-agents/src/lane/lanes.ts`: several paths rethrow raw fs and git errors (`throw e`), and "the lane of
  <v> cannot be moved: ${e}" carries the `Error:` prefix and an errno with no next step. Candidate: one shared helper
  that wraps an error with what was being done and what to try.
- `packages/host-agents/src/harness/types.ts`: `HarnessResult.reason` is free text used both by machines (`"cancelled"`)
  and by humans. Candidate: a code plus a message, if the CLI or executor branches on it.

Owner ruling 2026-10-14: decide when the CLI shows these errors.
