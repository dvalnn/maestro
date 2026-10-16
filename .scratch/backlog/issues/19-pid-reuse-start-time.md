# A concert's process identified by pid and start time

Status: needs-triage

Owner ruling 2026-10-16: an accepted risk, not expected to be fixed soon.

A concert row records its performer's pid only. When the performer dies unsettled and Linux hands its pid to another
maestro process, `kill <concert>` passes the `/proc/<pid>/cmdline` check and sends SIGTERM to that process, which may be
performing another concert. A pid taken by any other program is handled: `kill` signals nothing and settles the concert
`failed`.

The fix: store the performer's start time (`/proc/self/stat`, field 22) beside its pid, and treat the pid as the
concert's only while both match. Reaping then catches any reuse on every read, so `isMaestro` and `kill`'s settle branch
in `packages/cli/src/records.ts` go. Costs a record schema version bump.
