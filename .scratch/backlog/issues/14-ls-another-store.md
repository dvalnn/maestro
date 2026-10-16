# List another record store

Status: needs-triage

Owner ruling 2026-10-16: every CLI command targets exactly one record store, the data root that config resolves to (a
workspace's when it overrides the key, else the user default). `ls` lists that store only, and there is no `--all`,
which would need workspace discovery.

Deferred until someone needs it: an option on `ls` (and the other read verbs) naming another data root to read, for when
listing another workspace's store is intentional.
