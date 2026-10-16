# Secret handling

Status: needs-triage

Owner ruling 2026-10-16: in V1, `maestro config` prints composed values as they are, since it writes to the operator's
own stdout and not to a log. Secrets belong in config or the environment, never in params (CFG-03), and are not logged
(NFR-05). Deferred until a host or pack needs it:

- Masking values whose schema marks them secret (for example `writeOnly`) in `config` and in diagnostics.
- A secret source other than plain YAML or the environment.
