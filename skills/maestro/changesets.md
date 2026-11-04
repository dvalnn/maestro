# Changesets

A changeset is a directory: `base`, the commit the lane was cut from, then `0001.patch`, `0002.patch` and on, one commit
each, subject the lane version that wrote it, and a `message` file when made with one. An empty changeset holds `base`
alone.

## Show

`maestro cs show <id>` prints the concert's changeset as a diff on its base, the message first, without touching the
checkout; `--stat` or `--summary` for less. Hand that to the user.

- It shows the `result` node's changeset, else the last `ok` instance's; `--node <instance>` picks another. On a concert
  that is not `ok`, stderr warns it is that instance's, not a delivered result.
- `--node <instance> --partial` takes the work a failed, blocked or cancelled agent kept instead.

## Apply

Applying is the user's step, taken on their yes.

- `maestro cs apply <id>` stages it on the checkout's `HEAD`: `target.repo` as the concert was performed with, or
  `-C <repo>`. It refuses an empty changeset, uncommitted tracked changes, and a checkout without the base (fetch it).
  Exit 3: a patch left conflict markers in the files.
- `--commit` then commits it with the changeset's `message` and the user's git identity; with no `message` it stages
  nothing and exits 1.
- `maestro cs drop --yes [-C <repo>]` resets the checkout's tracked files, undoing an apply.
