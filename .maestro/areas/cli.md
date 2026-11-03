# Building in the CLI area

- A change to an exit code, a message or a `--json` shape also breaks tests outside `packages/cli`:
  `.maestro/slice.test.ts` and `packs/classics/src/classics.test.ts` run the real `maestro`. Verify with `check all`,
  never `bun test packages/cli` alone.
- A `--json` document, a serialized `Diagnostic` included, is read by scripts: a new, renamed or dropped field changes
  what they see. Update `packages/cli/README.md` with it.
- An exit code depends on where a diagnostic came from, not on its code alone (`isArgument` in
  `packages/cli/src/output.ts`): a `-c` value and a config-file value can exit differently. Probe both.
