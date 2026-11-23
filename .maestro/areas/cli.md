# Building in the CLI area

- A change to an exit code, a message or a `--json` shape also breaks tests outside `packages/cli`:
  `.maestro/slice.test.ts` and `packs/classics/src/classics.test.ts` run the real `maestro`. Verify with `check test`,
  never `bun test packages/cli` alone.
- A `--json` document, a serialized `Diagnostic` included, is read by scripts: a new, renamed or dropped field changes
  what they see. Update `packages/cli/README.md` with it.
- An exit code depends on where a diagnostic came from, not on its code alone (`isArgument` in
  `packages/cli/src/output.ts`): a `-c` value and a config-file value can exit differently. Probe both.
- Human output is held to `CODING_STANDARDS.md` (Terminal look). Its color and fitting show only on a terminal.
- A transcript pins how human output looks. Read `packages/transcript/README.md` before testing output. Draw it with a
  `terminal` dep and color on, at the widths a user meets.
- A change to human output adds no assertion on how it looks. It moves the assertions that describe that output into the
  transcript, and leaves the tests of output it does not change as they are.
