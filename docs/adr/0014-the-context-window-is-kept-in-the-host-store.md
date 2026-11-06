---
status: accepted
---

# The context window is kept in the host store

A profile's `at` can be a percentage of its model's context window, and pre-flight turns it into tokens. Pre-flight
starts no agent, so the window must be known before a run, and no harness lists it without running the model.

The decision:

- **The window is a file in the host store, `<data>/hosts/repo/windows.json`**, keyed by harness, then by model as the
  profile names it, in tokens.
- **The probe and every run write it.** `agent probe` and each agent turn keep the window their harness reports: claude
  on its closing `result` line, pi through its reporter extension.
- **Pre-flight only reads it.** A percentage for a model with no kept window is refused, and the fix says to probe or to
  write `at` in tokens.

## Considered options

- **A hand-kept model table.** Rejected: it goes stale with every model release, and the harnesses already report the
  window.
- **The record.** Rejected: pre-flight cannot reach the record, which belongs to a concert, and the record stays
  harness-agnostic.
- **Probing at pre-flight.** Rejected (D42): pre-flight stays free of spend, and a probe starts the harness.

## Consequences

- `windows.json` is a contract between the probe, the runs and pre-flight. A malformed file reads as empty, and the next
  probe or run rewrites it.
- A concurrent write may lose an entry, which the next probe or run restores.
