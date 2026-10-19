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
- A `README.md` stating each composition's purpose, params and the roles it needs, since no command lists them.

## Building the entry

Set the project up as the release's INSTALL.md, section "Authoring packs", says: Bun, and the three `@maestro` package
tarballs as `file:` dependencies. The source, `src/index.ts`, exports the pack's compositions and every function its
code nodes use. A build script bundles it behind the SDK's `glue`, which adds the `describe` and `build` exports maestro
loads the pack through, and writes the manifest with the SDK's own range:

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

## Roles, never models

A pack names roles (`builder`, `reviewer`, `skeptic`) and never a model or harness: the user maps roles to models in
config, since a model is spend. A composition that needs a model policy, such as a skeptic from another model family
than its lens, takes the models as params and checks them with a build-time `assert` over a helper of the pack's own,
such as `familyOf`:

```ts
assert(familyOf(lensModel) !== familyOf(skepticModel), "the skeptic's model family must differ from the lens's");
```

## Prompts

A prompt is a task, an identity and attachments:

- The task and the identity are `.md` files imported as text
  (`import task from "./prompts/build.md" with { type: "text" }`) and filled with build-time values by plain TypeScript.
  Text built from Refs comes from a code node. For `tsc`, declare the import's type once:
  `declare module "*.md" { const text: string; export default text; }`.
- What an agent reads at perform time reaches it as an attachment, mounted at `/in/<name>` with its `hint`.
- A `seat({ role, identity, verdict, attachments, out, checks, readOnly })` bundles an agent's standing setup once; each
  call adds the task and lane, may override the role, and adds to the rest.

## Config

Users configure a pack's composition params under its id:

```yaml
shop:
  release_notes:
    maxItems: 20
```

Precedence, highest first: the CLI flag, the profile, the workspace file, the user file, and the param's default
(compose also reads the example set, below config: [running.md](running.md), Compose). A key the pack does not claim
fails compose with a did-you-mean.

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
- Perform each as a stub concert with a profile mapping the pack's roles to `{ harness: stub, model: none }`, in a toy
  repository whose checks pass, then in one whose checks fail, and read both records with `maestro ls <id>`.
