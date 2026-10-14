---
status: accepted
---
# Packs are pre-bundled directories, not npm packages

A pack is a directory or release tarball with a `maestro-pack.json` manifest and one pre-bundled entry file that includes
its own copy of the SDK (D-30). Workspace config lists packs by path or URL, and nothing resolves through `node_modules`.
The compiled `maestro` binary embeds its own SDK, and an external file that imports the SDK gets a different copy, so a
shared-package model cannot work in a single-binary distribution.

## Considered options

- **Packs as npm packages resolved through `node_modules`.** Familiar, with versioning and dedup for free. Rejected
  because the compiled binary has no `node_modules` to resolve against, and distribution is internal with no public
  registry (D-31).
- **Pack imports the host's embedded SDK.** Would avoid the duplicate copy. Rejected because the binary does not expose
  its embedded modules to external files.

## Consequences

- Compose consumes only IR JSON, so a second SDK copy is harmless, provided nothing relies on `instanceof` across copies.
  Types that cross the pack boundary are checked by schema.
- Each pack is rebuilt when the SDK changes. The IR version (CORE-16) is what keeps an older pack usable.
- Slice 0 verifies that the binary loads an external bundle and calls its code node (D-32, spike 3).
