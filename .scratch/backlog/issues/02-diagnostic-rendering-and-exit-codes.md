# Nothing renders diagnostics or sets exit codes

Status: needs-triage

`parseIr` returns structured `IrDiagnostic`s (code, path, message, hint) and the host packages throw plain `Error`s, but
no code turns either into CLI output. Per CLAUDE.md "User-facing output", the CLI needs one formatter (for example
`<path>: <message>` then the hint, on stderr) and an exit-code policy (usage, rejected, failed), decided together.

Owner ruling 2026-10-14: belongs to the CLI slice, not before.
