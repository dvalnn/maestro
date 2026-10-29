---
status: accepted
---

# A host is its required members, flat, and optional members, with no version

A host gives core node kinds, types, config namespaces and hooks (architecture section 6). Its interface had grown
optional members one at a time: `param`, `release`, `usage`, `text`, `needs`, `paths` and `deferred` beside the required
ones, and no answer to whether the interface or the hosts that implement it carry a version.

The shape is:

- **Required members stay flat.** `name`, `kinds`, `types`, `config`, `validate`, `bounds` and `environment` sit on the
  host. Every host has them, and core calls each at a fixed stage, so grouping them by stage would add a level to read
  past without telling the reader anything.
- **`resources` is optional and holds `release` and `usage`.** Both act on the disk a host keeps for a concert, and a
  host that keeps none has neither, so they are present together or not at all. Neither is ever half implemented.
- **`text` is optional and holds `progress`, `actor`, `notes`, `report` and `reportFields`.** They word one of the
  host's progress events, as a word and a detail, name who ran an instance, give an instance's notes as headed lists of
  one-line entries, such as an agent's obstacles and lessons, all as plain text, give its full report as an opaque
  object for `ls --json`, and say in a line each what the fields of that report mean for `ls --help`. The CLI hands the
  text members to the renderer, which styles and cuts them and knows ir only, beside a closed table of event words that
  carries their styles and which never stand as an instance's latest line; a word outside it shows unstyled. `actor` is
  called on a settled instance's enrichment and on each of the host's progress events, and names an actor only for an
  event that announces one. A host that says nothing more than the generic line omits `text`, or any member.
- **`needs` is optional and names the config entries a graph's host nodes read by name**, such as
  `target.checks.<name>`, as key paths. The CLI lists them for a composition built from its example set and reads no
  host node config itself. A host that reads nothing by name omits it.
- **`param` stays flat and optional.** It reads one of the host's types from text and has no partner member.
- **`paths` is optional and lists the `config` keys that hold file paths**, namespace first, `*` matching any one key,
  which the CLI anchors to the workspace root, or to the user file's directory for a value in the user file.
- **`deferred` is optional and lists the `config` keys whose base arrives later**, such as `profiles.*`, whose base is a
  profile's `profile.yaml`. The first merge leaves a merge tag there that finds nothing beneath pending. The composed
  config keeps its layers, and core's `layeredOver` merges a setup's layers again over that subtree with the base as the
  lowest layer, when the host asks, so every merge tag acts on the base as on any layer.
- **A setup goes to `validate`, `environment`, `resources.release` and `resources.usage`**, and to `execute` through
  `HostContext.setup`. It holds the values of the config namespaces the host owns, as compose checked them, their
  sources and the layers they merged from, each cut to those namespaces, the part of them the preset and `-c` layers set
  (`commandLine`, at its key paths), and its store, `<data root>/hosts/<host name>`. The host creates its store on first
  write, so core holds no host directory a host never uses. It also holds the roots the CLI builds, which core never
  reads: the workspace's `.maestro`, `maestro` in the user's config directory, and each installed pack's directory by
  pack id. A host keeps its own entries under them. The context also names, in `HostContext.encore`, the concert an
  encore repeats, and each instance gives in `HostInstance.groups` the kind of each group enclosing it, outermost first.
  Core reads nothing a host keeps of them: a host that continues work across concerts matches an instance to its
  counterpart from its own store, never from the record.
- **No host version, and no host range in a pack manifest.** Hosts ship inside the binary, and the `sdk` range a pack
  declares pins them. The interface is frozen for V1 as an exercise, not as a promise to third parties.

## Considered options

- **Group members by stage** (`compose: { validate, bounds }`, `perform: { environment }`). Every group would hold one
  or two members, and a host would spell out a nested object to say what the flat form says directly.
- **Leave `release` and `usage` flat and optional.** A host could implement one and not the other, and `prune` would
  then free a concert it cannot size, or size one it cannot free.
- **Version the host interface now.** Nothing yet loads a host that did not ship with the binary, so a version has no
  reader and would be checked against nothing.
- **Hold a deferred subtree back raw**, unmerged, for the host to merge. The host would reimplement the merge tags, and
  the same YAML would merge one way under `profiles:` and another everywhere else.
- **Hydrate every base eagerly through a hook** before the first merge. Each concert would read every profile any root
  holds, not only those its graph seats, and a broken one it never seats would fail it.
- **Core creates each host's store.** It would make a directory for a host that never writes one, and for each host
  loaded, whether or not a graph uses it.

## Consequences

- A host that keeps nothing per concert omits `resources`, and the caller of `release` and `usage` skips it.
- Adding a required member to the host later breaks every host, which is acceptable while hosts ship with the binary.
  Out-of-binary hosts need a version and a manifest range first, and that decision is deferred with them.
- A host reads its own config from its setup and never reaches another host's namespace.
