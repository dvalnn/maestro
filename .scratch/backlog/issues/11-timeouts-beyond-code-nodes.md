# Timeouts beyond code nodes

Status: needs-triage

Owner ruling 2026-10-16: in V1 only a code node takes a `timeout`, set by its author, with none by default. Two
extensions are deferred until a composition needs them:

- A `timeout` option on every node kind, host nodes included, enforced through the kind's cancel hook.
- Letting an edge tolerate a timed-out upstream, the way it can tolerate `rejected` (CORE-04), so a composition can
  fall back instead of failing. Today a timeout settles `failed`, which no edge tolerates.
