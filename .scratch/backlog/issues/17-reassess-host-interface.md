# Reassess the host interface before it widens again

Status: needs-triage

Owner ruling 2026-10-16: V1's `Host` carries three optional members beside its required ones: `param` (a typed param
from text), `release` and `usage` (a concert's host resources, for `prune` and `ls`). They are right for one host, the
coding-agent host. `Host` must not grow into a cluster of unrelated optionals.

Trigger: the first time a second host (model calls, human in the loop, forge, containers, HTTP, remote execution) needs
a member the interface lacks. Before adding it, review the whole interface:

- Group the members by concern rather than as a flat list: compose time (`types`, `config`, `validate`, `bounds`,
  `param`), run time (`kinds`, `environment`), and resource lifecycle (`release`, `usage`). An optional capability could
  then be one facet object a host supplies whole, such as `resources: { release, usage }`.
- Check each optional member still has a reader, and drop the ones that do not.
- Give hosts a version, so a pack manifest can declare a range on the hosts it uses (PACK-02).
- Record the result in an ADR, since the interface is frozen from S7.
