---
status: accepted
---

# Maestro targets modern Linux, and RHEL 8 is best-effort

Maestro targets modern Linux x64 and is built with current tooling on a modern host. The host floor is Bun's own
documented platform minimum (kernel 3.10 or newer, with kernel 5.6 or newer recommended), and maestro adds no stricter
floor. RHEL 8 class hosts (glibc 2.28, kernel 4.18) are best-effort. A failure there is a documented known limitation
with a user workaround. It is not a blocker and not a reason to constrain tooling or the build host.

## Considered options

- **RHEL 8 as the minimum supported host.** NFR-08. Rejected because it would hold the toolchain and the build host back
  for a legacy platform.

## Consequences

- Spike 1 is judged on modern Linux, and its RHEL 8 run is a compatibility probe.
- Spike 5 no longer decides the release build host, since releases build on a modern host.
- AC-7 drops RHEL 8.
- Spikes 1 and 5 found that compiled binaries need glibc 2.17 at most, whatever the build host's glibc, and run in a
  Rocky Linux 8 userland. Kernel 4.18 itself is untested.
