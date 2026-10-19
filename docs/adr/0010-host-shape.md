---
status: accepted
---

# A host is its required members, flat, and optional `resources`, `text` and `needs`, with no version

A host gives core node kinds, types, config namespaces and hooks (architecture section 6). Its interface had grown
optional members one at a time: `param`, `release` and `usage` beside the required ones, and no answer to whether the
interface or the hosts that implement it carry a version.

The shape is:

- **Required members stay flat.** `name`, `kinds`, `types`, `config`, `validate`, `bounds` and `environment` sit on the
  host. Every host has them, and core calls each at a fixed stage, so grouping them by stage would add a level to read
  past without telling the reader anything.
- **`resources` is optional and holds `release` and `usage`.** Both act on the disk a host keeps for a concert, and a
  host that keeps none has neither, so they are present together or not at all. Neither is ever half implemented.
- **`text` is optional and holds `progress` and `actor`.** They word one of the host's progress events, as a word and a
  detail, and name who ran an instance, as plain one-line text. The CLI calls them and hands the strings to the
  renderer, which styles and cuts them and knows ir only, beside a closed table of event-word styles; a word outside it
  shows unstyled. `actor` is called on a settled instance's enrichment and on each of the host's progress events, and
  names an actor only for an event that announces one. A host that says nothing more than the generic line omits `text`,
  or either member.
- **`needs` is optional and names the config entries a graph's host nodes read by name**, such as `roles.reviewer`, as
  key paths. The CLI lists them for a composition built from its example set and reads no host node config itself. A
  host that reads nothing by name omits it.
- **`param` stays flat and optional.** It reads one of the host's types from text and has no partner member.
- **`paths` is optional and lists the `config` keys that hold file paths**, namespace first, which the CLI anchors to
  the workspace root, or to the user file's directory for a value in the user file.
- **A setup goes to `validate`, `environment`, `resources.release` and `resources.usage`**, and to `execute` through
  `HostContext.setup`. It holds the values of the config namespaces the host owns, as compose checked them, and its
  store, `<data root>/hosts/<host name>`. The host creates its store on first write, so core holds no host directory a
  host never uses.
- **No host version, and no host range in a pack manifest.** Hosts ship inside the binary, and the `sdk` range a pack
  declares pins them. The interface is frozen for V1 as an exercise, not as a promise to third parties.

## Considered options

- **Group members by stage** (`compose: { validate, bounds }`, `perform: { environment }`). Every group would hold one
  or two members, and a host would spell out a nested object to say what the flat form says directly.
- **Leave `release` and `usage` flat and optional.** A host could implement one and not the other, and `prune` would
  then free a concert it cannot size, or size one it cannot free.
- **Version the host interface now.** Nothing yet loads a host that did not ship with the binary, so a version has no
  reader and would be checked against nothing.
- **Core creates each host's store.** It would make a directory for a host that never writes one, and for each host
  loaded, whether or not a graph uses it.

## Consequences

- A host that keeps nothing per concert omits `resources`, and the caller of `release` and `usage` skips it.
- Adding a required member to the host later breaks every host, which is acceptable while hosts ship with the binary.
  Out-of-binary hosts need a version and a manifest range first, and that decision is deferred with them.
- A host reads its own config from its setup and never reaches another host's namespace.
