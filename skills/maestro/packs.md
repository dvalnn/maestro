# Pack authoring

Reference for building a pack: a set of compositions shipped and installed as one unit, configurable through its own
config namespace. Write the compositions first by [composition.md](composition.md); this page covers what changes when
they become a pack.

## What a pack is

A directory, or a tarball of one, holding:

- `maestro-pack.json`, the manifest:

  ```json
  { "id": "shop", "version": "0.1.0", "entry": "index.js", "sdk": "^0.1.0-beta.1" }
  ```

  - `id`: the pack id, lower case, starting with a letter, then letters, digits, `_` or `-`. Compositions are
    `<id>.<name>`, and the pack's config namespace is `<id>`.
  - `version`: the pack's own version.
  - `entry`: the bundle file, inside the pack directory.
  - `sdk`: a semver range on the SDK; a maestro whose SDK is outside it refuses the pack with a message to rebuild.

- The entry: one pre-bundled JavaScript file holding every composition the pack exports, its code nodes, its prompts and
  its own copy of the SDK. maestro resolves nothing through `node_modules` for a pack, and refuses an entry that imports
  anything but builtins and `@maestro/sdk`.
- A `README.md` stating each composition's purpose, params and the profiles it needs; `maestro rep` lists the same from
  the bundle.
- A `profiles/` directory, when the pack ships agents: one directory per profile, each a `profile.yaml` with the
  instructions and attachments it names, copied into `dist/profiles/` by the build. A seat names one as `<id>/<name>`.

## Building the entry

Set the project up as the release's INSTALL.md, section "Authoring packs", says: Bun, and the `@maestro` package
tarballs as `file:` dependencies, `@maestro/classics` only to build on the classics pack's parts. The source,
`src/index.ts`, exports the pack's compositions and every function its code nodes use. A build script bundles it behind
the SDK's `glue`, which adds the `describe` and `build` exports maestro loads the pack through, and writes the manifest
with the SDK's own range:

```ts
// build.ts: `bun build.ts` writes the pack into dist/
import { glue, SDK_VERSION } from "@maestro/sdk/loader";

const entry = `${import.meta.dir}/.entry.js`;
const built = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: glue("./src/index.ts") },
  target: "bun",
  format: "esm",
});
if (!built.success) throw new AggregateError(built.logs, "the pack did not bundle");
await Bun.write("dist/index.js", built.outputs[0]);
await Bun.write("dist/README.md", Bun.file("README.md"));
const manifest = { id: "shop", version: "0.1.0", entry: "index.js", sdk: `^${SDK_VERSION}` };
await Bun.write("dist/maestro-pack.json", JSON.stringify(manifest, null, 2));
```

`dist/` is the pack directory: list it under `packs`, or ship it as a tarball whose top directory is the pack id:
`tar -czf shop-0.1.0.tar.gz --transform 's,^dist,shop,' dist`.

Rebuild the entry whenever the SDK changes version. A code node's hash covers the whole bundle, so after a rebuild a
resume performs every code node of the pack again.

## Building on the classics

`@maestro/classics`, set up as Building the entry says, exports the classics pack's parts:

- `panel`: the lens, skeptic and consolidator panel, as a function over a change; given `grounds`, the rules a finding
  must cite, its skeptics and consolidator rule by them. `skepticTask(grounds)` is that skeptic task, for a lone
  skeptic.
- The seats: `builder`, `lens`, `skeptic`, `consolidator`, `scout`, `planner`, `documenter`.
- The compositions: `repairUntilGreen`, `panelReview`, `buildThenRepair`.
- `maxRepairs`, the repair bound, and `atLeastOne`, the at-least-one integer param.
- Code-node functions: `survivorsOf`, `toMarkdown`.
- Types: `Findings`, `Verdict`, `Verdicts`.

`repairUntilGreen` takes a `checks` param, the names in `target.checks` its repair agent may run with `check <name>`; it
defaults to none, and its recheck runs every check of the target.

## Profiles, never models

A pack ships profiles (`builder`, `lens`, `skeptic`) and names no model or harness in them: the user sets each profile's
`runtime` in config, as `profiles.<id>/<name>.runtime`, since a model is spend. A profile's `limits` may ship. Guidance
such as a skeptic from another model family than its lens belongs in the pack's README.

## Prompts

An agent reads five layers, in this order, each with one home; no layer restates another's text:

1. **Frame**, from the host: working copy, checks, attachment list, output schema. Never restated.
2. **Profile**, `profiles/<name>/instructions.md`: who the agent is and how it works, true in every call.
3. **Area**, a preset's profile `attachments`: what is true of one part of the target.
4. **Task**, `src/prompts/<call>.md` and its fragments: what this call asks, its inputs by name, its outputs, its bar.
5. **Attachments**, written by code nodes: the run's data, never instructions.

The task layer:

- Name a task file for its call's `label`. A composition file keeps one `TASKS` table near its top, each call's task as
  its file then the fragments it rules by, so one read shows everything a seat is told.
- The task is a `.md` file in the pack's `src/prompts/`, one per call, imported as text
  (`import task from "./prompts/build.md" with { type: "text" }`; the attribute is mandatory, or Bun imports Markdown as
  HTML). A text shared by several tasks is a `_`-prefixed file joined after each as a paragraph. Build-time one-line
  values fill `{name}` placeholders; `fill` in `@maestro/classics` does it and throws on an unmatched name or value.
  Text built from Refs comes from a code node. For `tsc`, declare the import's type once:
  `declare module "*.md" { const text: string; export default text; }`.
- Keep a JSON shape example in a fenced `json` block, and its field rules as prose under it.
- What an agent reads at perform time reaches it as an attachment, mounted at `/in/<name>` with its `hint`.
- A `seat("<name>", { profile, verdict, out, checks })` bundles an agent's standing setup once, with
  `profile: "<id>/<name>"` for a pack's own profile; each call adds the task and lane, and adds attachments, outputs and
  checks.

## Config

Users configure a pack's composition params under its id:

```yaml
shop:
  release_notes:
    maxItems: 20
```

Precedence, highest first: the CLI flag, the preset, the workspace file, the user file, and the param's default (compose
also reads the example set, below config: [running.md](running.md), Compose). A key the pack does not claim fails
compose with a did-you-mean.

## Trust

Code nodes run in maestro's process with the user's permissions, outside the sandbox that confines agents and checks.
Install and list under `packs` only packs the user chose.

## Installing

Extract the pack into the packs directory, `$XDG_DATA_HOME/maestro/packs` (default `~/.local/share/maestro/packs`), with
`tar -xzf <pack>.tar.gz -C <that dir>`; no `packs` entry is needed. A pack kept elsewhere is listed by its directory
under `packs` in the user or workspace config. Then `maestro rep <id>` lists its compositions, and
`maestro compose <id>.<composition>` loads it.

## Testing

- Compose every composition: `maestro compose <id>.<composition>`.
- Perform each as a stub concert with a preset setting each of the pack's profiles' `runtime` to
  `{ harness: stub, model: none }`, in a toy repository whose checks pass, then in one whose checks fail, and read both
  records with `maestro ls <id>`.
