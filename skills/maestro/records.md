# Records

How to read what a concert left: its instances, their outputs and artifacts, and its lanes.

## Instances

`maestro ls <id>` lists the concert's node instances in graph order: instance, status, `stale`, reason.

- `maestro ls <id> <instance>` lists one instance alone: name it as `ls <id>` does, or by a unique ending of whole
  segments, such as `repair`.
- An instance name shows its place: `loop[0]/repair` is a loop's first repair, `parMap[risk]/skeptic` the skeptic of
  item `risk`.
- `stale` marks a row an earlier attempt of a resumed concert left, neither reused nor replaced.
- The reason of the instance the closing block's `at` names is the concert's root cause.
- `--json` gives the concert's row and `instances`, each with `status`, `reason`, `outputs`, `metrics`, `artifacts`,
  `stale` and `inputs`: the values a leaf was fed on its wired ports. Literal ports are in the IR, never in `inputs`.

## What each node leaves

- An agent: `report`, `{ summary, gaps?, obstacles?, lessons?, sightings? }`; `staged`, a directory of its task
  (`prompt.md`), its system prompt (`instructions.md`: the profile's instructions, then the host's frame) and each
  correction turn (`correction-1.md` on); `lane`, its version; and each declared output.
- A check: `logs`, each line it ran and its output; `lane`, unless it only read one.
- A changeset node: `changeset` ([changesets.md](changesets.md)).

## Artifacts

- `maestro art ls <id>` lists artifacts: instance, port, absolute path, `stale`.
- `maestro art show <id> <instance>` prints each file of an instance's artifacts, after a `══ <file>` line when there
  are several; `maestro art show <id> <instance> <file>` prints one, so it pipes. A file is its artifact's basename plus
  any inner path, such as `staged/prompt.md`. `--path` prints paths instead. An instance with no artifacts exits 1.

`art` and `watch --instance` take an instance as `ls <id>` prints it, or a unique ending of whole segments, such as
`repair` for `loop[0]/repair`. An ambiguous ending is a usage error listing the matches.

## Lane refs

A lane version is written `<concert id>.<node instance>`, such as `01a15170-e9ec-7089-81d3-c7af21271198.test`; a
`perform` prints one as a `lane` output, and `ls <id> --json` gives each instance's. A later composition takes one as a
`Lane` param and can fork it, read it or make it a changeset, never extend it. Lanes stay until their concert is pruned.

A lane's working tree is `hosts/repo/<target id>/lanes/<concert id>/<instance>/work` under the data root, under the last
instance that extended it, URL-encoded (`loop[0]/repair` is `loop%5B0%5D%2Frepair`). Earlier versions are sealed in the
host's git store.

## Data root

`$XDG_DATA_HOME/maestro` (default `~/.local/share/maestro`), unless config's `dataRoot` moves it:

| Path                             | Holds                                                                      |
| -------------------------------- | -------------------------------------------------------------------------- |
| `record.db`                      | The record of concerts, node instances and events (SQLite)                 |
| `concerts/<id>/artifacts/<path>` | Each artifact, at the `path` its JSON shows                                |
| `hosts/repo/<target id>/`        | The repo host's lanes, versions, sessions and partials, per target[^store] |

[^store]:
    An agent's session is `sessions/<concert>.<instance>/`, URL-encoded, and `<concert>.<instance>#<k>` for session k a
    handoff started, its transcript under `harness/` and its last turn in `turn.json`; `latest/<concert>/<instance>`
    names the latest session each agent instance ran, which an encore continues; a failed agent's partial work is
    `partials/<concert>.<instance>`, read with `cs --partial`.
