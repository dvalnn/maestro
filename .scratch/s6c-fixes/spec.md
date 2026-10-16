# S6c. Drop node purity, and the CLI demo and wave 4 fixes

Status: ready

Slice:        S6c (contract-setting: the IR loses `pure`, `perform` and `wait` print the result's outputs)
Goal:         Compose runs no author code; a bare file's config and a concert's result behave as the demo showed they
              must; the wave 4 review's code findings are fixed.
Read:         .scratch/wave3/morning-calls.md (K94, K99, K104 to K110), docs/reports/wave-4-review.md, CLAUDE.md,
              CODING_STANDARDS.md, docs/agents/implementation-loop.md ("Owner calls"), requirements CORE-05, CORE-07,
              SDK-04, SDK-11, SDK-13, D-16, D-18, CLI-02, CLI-04; architecture 4 and 6; sdk-spec 4, 5, 7 and 13.3;
              ADRs 0004, 0008 and 0009; packages/core/src/compose/README.md; the S6a and S6b reports.
Package:      packages/core/src/compose/, packages/core/src/worker.ts, packages/core/src/perform/, packages/ir/,
              packages/sdk/src/, packages/cli/, packages/testkit/.
Deliverables:
  1. No node purity (K108). Compose stops folding: `fold` and its tests go, along with `Plan.folded`,
     `ComposeInput.scratch`, the folded lines of `--plan` and `--graph`, and the summary's folded count. The check that
     every worker reference resolves stays (`loadFunctions`, moved out of `fold.ts`). Groups expand from plain values
     only; one sized by a node result stays a bounded region (CORE-05). A `map` key function runs only at perform
     (K110): compose expands a build-time list to its length, checks primitive and index keys, and never calls a key
     function. `assert` is decided at build when its condition is plain, else at perform. The IR's `pure` field goes
     from `types.ts`, `ir.schema.json`, the README and the fixtures (still IR 1.0, the changelog's entry noting it). The
     SDK's `pure` option and the worker's `pureContext` go: every code node may read `ctx.clock` and `ctx.concert`.
     SDK-11's frozen ambient state during build stays, its codes renamed `BUILD.ambient` and `BUILD.unstable` (K109).
  2. Bare files and config (K104): a bare file takes params from flags, its example set and its defaults only. A YAML
     key under its pack id is unclaimed like any other, and the hint says a pack is how to configure it.
  3. A concert's result (K105): `perform` and `wait` print the result node's outputs. `--json` gains `outputs`, as
     stored. Text prints one `name  value` line per port on stdout after the id: a one-line string, number, boolean or
     null as is, anything else as compact JSON, and an artifact anywhere in a value as its path. A rejected result
     carries its root cause's rejection outputs; a failed one has none. `ls` prints no outputs.
  4. Wave 4 code findings:
     - 1: a build diagnostic from a bundle carries no location unless it is an absolute file path; fix the comment in
       `sdk/src/diagnostic.ts`.
     - 2: a bare file's stem is checked against the pack id pattern and against installed pack ids, each a usage error
       (exit 2) naming the file and saying to rename it.
     - 3 (K106): the manifest's `hosts` ranges and `Versions.hosts` go, so a manifest naming `hosts` fails its
       schema.
     - 4 (K107): `tour` takes the alias `t`.
     - 5: one walker over an IR's worker references in `@maestro/ir`, under both `withCurrentHashes` and `mapWorkers`.
     - 6: resume's refusal lives in core only, and core performs the IR the CLI pre-flighted, so the code that runs is
       the code that was checked, for a fresh concert and a resume alike.
     - 11: core exports `messageOf` and `sha256Hex` without making its internal helper module public; the CLI exports
       only what another file uses.
     - 12: `ls` shows and filters compositions as `<pack>.<composition>`.
  5. `packages/cli/README.md`: `caps` as caps by name, and every `prune` flag. `packages/core/src/compose/README.md`
     without folding.
Acceptance:   A composition whose code node prints performs and prints once, and `compose` prints nothing
              from it; `compose --plan` shows no folded values; a group sized by a build-time list expands exactly, one
              sized by a node result stays bounded; a code node reads `ctx.clock`; a key function giving duplicate keys
              over a build-time list composes and fails the `map` at perform; an ambient read in a build is
              `BUILD.ambient`; a hand-written IR with `pure` is refused by the schema; a bare file's YAML key is
              unclaimed whichever target runs; `perform` and `wait` show the result's outputs, with and without
              `--json`; a bundle's build error prints no base64; a bad or colliding stem exits 2 naming the file;
              `ls --composition greet.hello` filters; `just check` output.
Out of scope: did-you-mean for flags (backlog 20); the pid start time (backlog 19); docs under `docs/` and GLOSSARY,
              which the conductor lands with the rulings.
Constraints:  clean break, no domain words, lean (NFR-09), no new dependencies. Prefer deletion. Follow "Owner calls".
Open Qs:      none; K104 to K110 are ruled.
Report:       .scratch/s6c-fixes/report.md, with the Loop table and a "Derived, not ruled" table.
