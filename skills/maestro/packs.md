# Pack authoring

A pack is a set of compositions shipped and installed as one unit, configured under its own config namespace. Write the
compositions first by [composition.md](composition.md); this page covers what changes when they become a pack.

## What a pack is

A directory, or a tarball of one, holding:

- `maestro-pack.json`, the manifest:

  ```json
  { "id": "shop", "version": "0.1.0", "entry": "index.js", "sdk": "^0.1.0-beta.1" }
  ```

  - `id`: lower case, starting with a letter, then letters, digits, `_` or `-`. Compositions are `<id>.<name>`, and the
    config namespace is `<id>`.
  - `entry`: the bundle file, inside the pack directory.
  - `sdk`: a semver range; a maestro whose SDK is outside it refuses the pack with a message to rebuild.

- The entry: one pre-bundled JavaScript file holding every composition, code node and prompt, and its own copy of the
  SDK. maestro resolves nothing through `node_modules` for a pack, and refuses an entry importing anything but builtins
  and `@maestro/sdk`.
- `README.md`: each composition's purpose, params and the profiles it needs.
- `profiles/`, when the pack ships agents: one directory per profile, copied into `dist/profiles/` by the build. A seat
  names one as `<id>/<name>`.

## Building the entry

Set the project up as the release's INSTALL.md, section "Authoring packs", says: Bun, and the `@maestro` package
tarballs as `file:` dependencies, `@maestro/classics` only to build on the classics pack's parts. `src/index.ts` exports
the compositions and every function their code nodes use. A build script bundles it behind the SDK's `glue`, which adds
the `describe` and `build` exports maestro loads a pack through:

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

`dist/` is the pack directory: list it under `packs`, or ship a tarball whose top directory is the pack id:
`tar -czf shop-0.1.0.tar.gz --transform 's,^dist,shop,' dist`. Installing is in [config.md](config.md), section Packs.

Rebuild whenever the SDK changes version. A code node's hash covers the whole bundle, so after a rebuild a resume reruns
every code node of the pack.

## Building on the classics

`@maestro/classics` exports the classics pack's blocks in layers; the pack's `README.md` holds each one's ports, params
and contracts. `@maestro/classics/code` exports its code-node functions alone.

- Entries, performed as `classics.<id>`: `buildThenRepair` (`build_then_repair`), `buildThenReview`
  (`build_then_review`), `panelReview` (`panel_review`).
- Patterns, which a composition `use`s: `repairUntilGreen` (`repair_until_green`), `panel`, `fixUntilClean`
  (`fix_until_clean`), `testFirst` (`test_first`).
- Moves: `challenge`, `fix`, `tally`.
- Contracts: `Finding`, `Upheld`, `Tally`, `TestMap`, `Brief`, `Overrules`, `Answers`, the types `Findings`, `Rulings`
  and `Verdict`; code-node functions `toMarkdown`, `specOf`, `briefOf`, `heldOf`, `tallyOf` and `resultOf`; `fill` for
  prompt placeholders ([prompts.md](prompts.md)); `LENSES`; params `maxRepairs`, `maxFixes` and `atLeastOne`.
- Seats: `builder`, `tester`, `lens`, `skeptic`, `consolidator`, `scout`, `planner`.

Take the layer you need: perform an entry, `use` a pattern in a composition, or call a move or seat among your own
nodes. `src/recipes.ts` in the pack holds five compositions of these blocks as test fixtures to copy from.

## Profiles, never models

A pack's profiles name no model or harness: the user sets each `runtime` in config, as `profiles.<id>/<name>.runtime`,
since a model is spend. `limits` may ship. Model guidance, such as a skeptic from another family than its lens, belongs
in the README.

## Config

Users set a pack's composition params under its id:

```yaml
shop:
  release_notes:
    maxItems: 20
```

Precedence, highest first: the CLI flag, the preset, the workspace file, the user file, the param's default; compose
alone also reads the example set, below config. A key the pack does not claim fails compose with a did-you-mean.

## Trust

Code nodes run in maestro's process with the user's permissions, outside the sandbox that confines agents and checks.

## Testing

- Compose every composition: `maestro compose <id>.<composition>`.
- Perform each as a stub concert ([stub.md](stub.md)) in a toy repository whose checks pass, then in one whose checks
  fail, and read both records with `maestro ls <id>`.
