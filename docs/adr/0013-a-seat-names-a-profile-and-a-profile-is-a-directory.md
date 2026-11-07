---
status: accepted
---

# A seat names a profile, and a profile is a directory

Agent identity was spread over `roles` config, config profiles and inline role fields in compositions. Beyond a single
workspace it had no shape: a pack could not ship an agent setup a workspace could tune, and a one-off agent had a third
way to be defined. An agent's setup is now one named thing, a profile, and a composition only names it.

The shape is:

- **A profile is a directory** whose `profile.yaml` is its manifest. It names its instructions and attachments by paths
  relative to itself, and every such path stays inside the profile's namespace directory, the directory that holds it,
  so profiles of one level may share a file. Nothing is discovered from the layout.
- **A profile names one extras directory** in `harnessExtras`, by the same path rule. Its adapter reads it in the
  harness's own layout and copies it into the config dir it owns for the session, so a directory holds every file it
  needs and each link in it stays inside it. A harness that does not read extras refuses the field at pre-flight.
- **Roots, highest first:** the workspace's `.maestro/profiles/`, the user's `$XDG_CONFIG_HOME/maestro/profiles/`, then
  the pack bundle's `profiles/`. The highest root holding a name wins it whole. Copying a pack's directory to a higher
  root is a deliberate shadow of it.
- **A bare name is unowned, a name with `/` is a pack's.** `auditor` resolves in the workspace or user root.
  `classics/builder` resolves in `<root>/profiles/classics/builder/`, then in the bundle's `profiles/builder/`. The
  bundle's manifest names the pack, so a bundle cannot ship another pack's profile. There is no fallback between the two
  forms.
- **A seat names one profile and holds no defaults.** `seat("<name>", { out, verdict, checks })` defaults its profile to
  its own bare name, and `{ profile }` names another. A pack's seat names its profile in full,
  `seat("builder", { profile: "classics/builder" })`. Runtime, limits and context belong to the profile and to config,
  so a call sets none of them and the command line keeps the last word. A call that needs another budget uses another
  seat bound to another profile.
- **Config tunes and rebinds, in YAML only.** `profiles: { <name>: { ...fields } }` tunes a profile by name, and
  `seats: { <composition id>/<seat>: <profile> }` rebinds a seat. Presets and `-c` use the same keys.
- **Resolution happens at pre-flight**, and again on a resume, under the config as it stands. The IR holds the profile
  name only.

## Considered options

- **Ad-hoc profiles declared in the seat or the composition.** A composition shipped in a pack would carry agent
  settings no workspace could tune by name, and an agent would have two ways to be defined. Rejected: a one-off agent
  ships a profile directory in the roster like any other.
- **Profile inheritance, or merging directories field by field.** Rejected: one profile per seat, the highest root wins
  whole, and finer changes go through config tuning.
- **A search across namespaces** (a bare name falling back to a pack's profile). Rejected: a name says which form it is,
  and there is no fallback between them.
- **A seat's profile defaulting to its name in the declaring pack.** A build knows only its root composition's pack, so
  a classics seat called from a workspace composition would resolve in the workspace's pack. Rejected: a pack's seat
  names `<pack id>/<name>` itself.
- **A reserved `global/` namespace for unowned profiles.** Rejected: a bare name is unowned, so the extra path segment
  added nothing.

## Consequences

- The profile directory, the `profile.yaml` schema, the `profiles:` and `seats:` config keys and the roots are
  contracts: a pack bundle, a workspace and a composition depend on them.
- `.maestro/profiles/` holds profile directories, so today's config profiles move to `.maestro/presets/`, and a pack
  build copies `profiles/` into the bundle.
- The word "role" leaves the vocabulary: `GLOSSARY.md` carries Profile, Seat and Shadow.
