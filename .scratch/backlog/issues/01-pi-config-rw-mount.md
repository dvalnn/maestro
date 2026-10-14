# pi config dir is mounted read-write in the sandbox

Status: needs-triage

Owner ruling 2026-10-14: V1 mounts pi's config dir (`~/.pi/agent`) read-write inside the sandbox, as the legacy system
does. Known sandbox defect, accepted for V1.

Why read-write: pi takes a lock with `mkdir settings.json.lock` next to `settings.json`. A read-only bind fails with
EROFS and then a misleading "No API key found" (`docs/reports/s0/spike-4.md`).

Risk: a sandboxed agent can change pi's real config (`settings.json`, `auth.json`), and pi reads that config again
on later runs, including runs outside maestro.

Candidate fix: a tmpfs config dir with the needed files bound on top, proven in spike 4. Open point: an OAuth token
refresh writes `auth.json` and would fail or be lost with that setup.
