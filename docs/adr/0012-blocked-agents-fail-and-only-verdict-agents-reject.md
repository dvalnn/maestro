---
status: accepted
---

# A blocked agent fails, and only a verdict agent rejects

Every agent's envelope carried `outcome: ok | rejected`, and the host's contract told any agent to reject when its own
verdict was negative. A builder that could not do its job then rejected, and a repair loop that tolerated the repair's
rejection checked the lane again, spending a check on work the agent had already given up on. Rejection, a negative
verdict on work after doing the job, and being blocked, unable to do the job at all, were one signal.

The rule is:

- **Every agent may reply `blocked: "<cause>"`** when it cannot proceed, the cause is outside its reach, and nothing
  later in the concert will change it. A blocked agent settles `failed` with the reason `blocked: <cause>`. The host
  does not demand its declared files, and seals no lane version.
- **Only a verdict agent gives a verdict**, `outcome: ok | rejected` with a `reason` when rejected. `verdict: true` on
  an agent or a seat marks one, and the host passes the mark to the harness. Any other agent is a work agent: its
  envelope has no `outcome`, so it finishes or is blocked.
- **A verdict agent gives exactly one of a verdict and blocked.** An envelope with both or neither, or a work agent's
  with an `outcome`, gets the usual correction turn.
- **The contract states only the fields of the agent's kind**, and the bar for blocked in the same words for both.

## Considered options

- **A `blocked` engine outcome.** Core would gain a fifth outcome for one host's concept, with no edge that tolerates it
  differently from `failed`. Rejected: a blocked agent is a failure the concert cannot recover from.
- **Keep one envelope and tell builders when to reject.** The prompt cannot keep a builder from rejecting a red check it
  could still fix, and a loop that tolerates the rejection cannot tell giving up from a negative verdict. Rejected.

## Consequences

- A repair that reports blocked fails the concert at once; the repair loop tolerates only a red recheck.
- An agent that declares no kind is a work agent, so a pack marks its reviewing seats `verdict: true`.
- No one reply fits both kinds, so the built-in stub harness replies by the request's `verdict` mark: a bare report, or
  an `ok` verdict.
