# Selecting one composition of a bare file

Status: needs-triage

Owner ruling 2026-10-16: a bare file that exports several compositions is a usage error listing their names. A selector
such as `maestro perform ./flows.ts#greet` is a good idea, deferred until a use case needs it.
