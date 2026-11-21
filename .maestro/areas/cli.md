# Building in the CLI area

- A change to an exit code, a message or a `--json` shape also breaks tests outside `packages/cli`:
  `.maestro/slice.test.ts` and `packs/classics/src/classics.test.ts` run the real `maestro`. Verify with `check test`,
  never `bun test packages/cli` alone.
- A `--json` document, a serialized `Diagnostic` included, is read by scripts: a new, renamed or dropped field changes
  what they see. Update `packages/cli/README.md` with it.
- An exit code depends on where a diagnostic came from, not on its code alone (`isArgument` in
  `packages/cli/src/output.ts`): a `-c` value and a config-file value can exit differently. Probe both.
- Human output is held to `CODING_STANDARDS.md` (Terminal look). Its color and fitting show only on a terminal. A test
  pins them with a `terminal` dep and color on. A check by eye runs the command in a pty, such as
  `script -qc "stty cols 80; maestro ls" /dev/null`.
