# Stdlib typed artifact readers wait for the artifact reference shape

Status: needs-triage

Owner ruling 2026-10-15: out of S2. A reader is a pure code node that receives an artifact reference at perform time,
and that shape is fixed by core in S4 (ADR 0007), which the SDK cannot import.

The reference shape itself does not wait: `ArtifactRef` lands in `packages/ir` (S1c) before S2 and the core seams,
because SDK port types, the worker interface and the record all need it. Only the reader nodes wait, until before the
first pack composition needs one (S9 at the latest).

Owner ruling 2026-10-15: a `core.text` artifact type is decided together with readers and `tpl` (backlog 07), not
before. CORE-15's "text" is covered by `core.markdown` until then.
