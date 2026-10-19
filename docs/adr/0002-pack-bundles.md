---
status: accepted
---

# Packs are pre-bundled directories, not npm packages

A pack is a directory or release tarball with a `maestro-pack.json` manifest and one pre-bundled entry file that
includes its own copy of the SDK (D-30). Workspace config lists packs by path, and nothing resolves through
`node_modules`. The compiled `maestro` binary embeds its own SDK. A bare composition file bundles against the binary's
embedded SDKs (the loader's `maestro-sdk` plugin), but a pack keeps its own copy, so its bytes, not the binary's, fix
what a resume replays. A shared-package model cannot work in a single-binary distribution.

## Considered options

- **Packs as npm packages resolved through `node_modules`.** Familiar, with versioning and dedup for free. Rejected
  because the compiled binary has no `node_modules` to resolve against, and distribution is internal with no public
  registry (D-31).
- **Source packs, each with its own `node_modules`.** Re-examined for code references (ADR 0008): a bare file and a pack
  would load the same way, and cache keys could follow each module's imports. Rejected: an install step per pack, a hash
  over each import graph, resolution leaking through an ancestor `node_modules`, and no single file whose bytes a resume
  can trust.
- **Pack imports the host's embedded SDK.** Would avoid the duplicate copy, as a bare composition file does by bundling
  against the embedded SDKs. Rejected because the pack's bytes would then depend on the binary: a new binary would
  change what a resume replays from the same pack.

## Consequences

- Compose consumes only IR JSON, so a second SDK copy is harmless, provided nothing relies on `instanceof` across
  copies. Types that cross the pack boundary are checked by schema.
- Each pack is rebuilt when the SDK changes. The IR version (CORE-16) is what keeps an older pack usable.
- Authors export compositions plainly. Whatever bundles them adds an entry exporting the bundle's own SDK `describe()`
  and `build()`, imported from `@maestro/sdk/loader`, so the CLI builds through that copy and reads each composition's
  params and examples without building.
- Slice 0 verifies that the binary loads an external bundle and calls its code node (D-32, spike 3).
