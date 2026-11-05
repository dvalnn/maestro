---
status: proposed
---

# A concert forks from an earlier concert's recorded results

Deferred. Starting a concert from an earlier concert's results is wanted, once the coding-agent host's lanes exist. It
takes the place of a result cache across concerts, which v1 does not have. The shape is settled:

- **Selection is by name.** A composition with ports may run at the root. The CLI feeds each port from a recorded node
  instance of an earlier concert, written `<concert id>.<node instance id>` like a lane ref. This lifts the rule of
  [sdk-spec's Writing a composition](../sdk-spec.md#writing-a-composition) that a composition with ports runs only
  through `use`.
- **Ports are checked before any spend.** Each port's schema is checked against the recorded outputs. A missing
  instance, a non-`ok` one or a type mismatch is a usage error.
- **Values are copied into the new concert's record.** Artifacts come in by content hash, so pruning the earlier concert
  stays safe. Lanes are fork-only. A map instance feeds its `results`.

## Considered options

- **Re-declare a prefix and reuse each node whose key matches a recorded one.** Rejected because its misses are silent
  and they spend.
