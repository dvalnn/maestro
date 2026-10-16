# Event sinks

Status: needs-triage

Owner ruling 2026-10-16: V1 has no event sink config. Every event goes to the record, and `watch` reads it there.
Deferred until a third-party consumer needs it: a sink that copies the event stream elsewhere, such as a JSON-lines
file.
