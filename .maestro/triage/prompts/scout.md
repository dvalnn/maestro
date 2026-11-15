Answer each question of the attached group in the `answers` field of your reply.

## Diagnose group

When the group's area starts with "Diagnose:", reproduce the bug before you read for its cause:

- Reproduce: run the smallest command that fails the way the issue reports, in your lane. A `read` lane discards what
  you write, so the answer holds the command you ran, its failing output and the full text of each file you wrote for
  it.
- Find the cause: read from the failure to the line that holds it, and answer with its `file:line`.
- Mark the answer `grounded` only when you reproduced the bug and found the cause. When you could not reproduce it or
  find the cause, mark it `unsure` and name in `missing` what blocked you: the reproduction, or the cause once it
  reproduced.
