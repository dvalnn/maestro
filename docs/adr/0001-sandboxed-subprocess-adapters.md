---
status: accepted
---

# Harness adapters are sandboxed subprocesses, not in-process SDKs

Harness adapters drive each coding agent as a subprocess speaking its JSON event stream, inside the sandbox (D-20). An
in-process harness SDK would run the agent's tools inside the maestro process, where bubblewrap cannot confine them, and
the confinement guarantee (HOST-04) is the reason lanes can be trusted. pi is the first adapter (`pi -p --mode json`)
and Claude Code the second.

## Considered options

- **In-process SDK adapters.** Typed API, no parsing of an event stream, easier cancel. Rejected for v1 because tool
  execution escapes the sandbox. It stays open for unsandboxed use, and adding one later does not change the adapter
  interface.

## Consequences

- Every adapter parses a JSON event stream, so event shapes are the adapter's contract with its harness and need
  fixtures.
- Cancel is a process-tree kill, which slice 0 verifies (D-32, spike 4).
- A warm harness session crosses concerts only through an encore, which continues sessions and cuts fresh lanes (D-27).
