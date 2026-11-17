---
status: accepted
---

# A concert records its config

Commands on a performed concert used to rebuild its config from the files of the folder they ran in. That rebuild failed
or differed from what ran, when run elsewhere or after the config changed. So `perform` records the text of each config
layer it parsed, and how it read it, as the concert's **snapshot**. The commands on the concert parse and compose those
texts in place of the current folder's files, as [architecture: Config snapshot](../architecture.md#config-snapshot)
states.

No command on a recorded concert reads config from a workspace. Those that run or show its agents read only profiles
from the recorded workspace directory. `dataRoot` stops being a config key.

## Considered options

- **Record the composed values.** Rejected: values lose what the repo host needs to resolve a profile. They lose a
  `profiles."*"` entry over a named profile, a `!replace` over a profile file and a pending `!delete`. An encore of a
  `--preset stub` rehearsal would run real agents.
- **Record each layer's entries as JSON.** Rejected: that needs a codec of its own for every YAML value. The text and
  how it was read parse again to the same layer.
- **Record the folder the concert ran from**, and read its files again. Rejected: the files may have changed or gone,
  and the command still depends on them. The recorded workspace directory differs: no config is read from it. A host
  only looks up profile files there.
- **Record the preset names and `-c` text**, and layer them again over the files as they stand. Rejected for the same
  reason; it is what the record did before.

## Consequences

- Commands on a concert run from any folder, and the fallbacks that worked around the old rebuild go.
- Concerts recorded before snapshots stay listed. Commands that need the snapshot refuse them, except `changeset show`
  and `apply` with `-C`.
- The record keeps the values of config files, so secrets belong in `.env`.
- Separate data roots return only as their own designed feature.
