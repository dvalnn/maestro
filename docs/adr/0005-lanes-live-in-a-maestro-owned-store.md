---
status: accepted
---

# Lanes live in a maestro-owned store, and each lane gets a small read-only git directory

Each lane root holds one bare git repository owned by maestro, the store. A base is copied into it with
`git fetch <target> <sha>`, so the target is only read, by `rev-parse` and `upload-pack`. A version is a commit in the
store under `refs/maestro/<concert>/<node instance>/version`. The changeset is `format-patch` from the chain's base to
the version. This settles HOST-03.

A lane is one directory with two parts:

- `work` is the working copy, which the sandbox mounts at `/lane`. Its `.git` file names the lane's git directory.
- `git` is the lane's own git directory: `HEAD` (the lane's commit, detached), the index, an empty `refs/`, and
  `objects/info/alternates` pointing at the store's objects. It has no refs, no packed-refs and no logs.

Sealing runs `add -A`, `write-tree` and `commit-tree`, then moves `HEAD`. The host always passes
`--git-dir=<store> --work-tree=<work>` with the lane's index, and never opens the lane's `.git`. It rewrites that file
every time it opens a lane. It also passes `--attr-source=<empty tree>`, so the lane's `.gitattributes` cannot change
the bytes that are sealed or checked out. That flag needs **git 2.40 or newer**. git runs with no system or global
config and with a fixed `maestro` identity. An extend moves the lane directory with one `rename`.

## Inside the sandbox

The sandbox binds two paths read-only, at their host paths (`Lane.readOnly`): the lane's `git` directory and
`<root>/store.git/objects`. With those binds, `git status`, `diff`, `log`, `show` and `blame` work in `/lane`.
`git status` exits 0 with correct output and silently skips the index refresh. Every write to git fails: `add`,
`commit`, `update-ref`, files in the git directory, and files in the objects.

What an agent can discover:

- Through history: its own lane's ancestry, meaning the target's history up to the base plus its own chain of versions,
  whose subjects are those versions' ids.
- In the file system: the host path of its git directory and of the store's objects.
- Nothing else is named anywhere it can see. `git log --all`, `for-each-ref` and `reflog` show only that ancestry, and
  the store's refs are not mounted.
- By enumerating objects (`cat-file --batch-all-objects`, or a listing of the objects directory), it can read objects
  that no visible ref names: other lanes' and other concerts' versions, and target commits fetched for other bases. No
  ref, reflog or packed-refs entry it can see names them. Accepted as a known V1 gap: lanes isolate writes, not reads
  between the agents of one store. Giving each lane only its own objects stays open for a later version.

## Considered options

For materialising lanes:

- **`git worktree add` on the target.** This is what the predecessor did. It writes `.git/worktrees/`, and commits land
  in the target. A toy probe changed 18 entries under the target's `.git`. Rejected.
- **A local `git clone` of the target.** It hardlinks the target's objects. That changes their ctime (18 entries in the
  probe) and shares inodes with a directory the agent can write to. Rejected.
- **`clone --shared`, alternates or `--reference` to the target.** The lanes would depend on the target's objects, so a
  gc in the target after a rebase corrupts them, and the sandbox would have to bind the target. Rejected.

For git inside a lane:

- **`git worktree add` on the store.** Its worktrees share the store's refs, so `git log --all` would show every lane of
  every concert. Rejected for lane isolation.
- **Binding the whole store, or using `GIT_NAMESPACE`.** The whole store exposes its refs. Namespaces only scope
  transport commands, not `log` or `for-each-ref`. Rejected.
- **A clone per lane, or a git directory inside the lane.** The agent could commit, and the host would then run git
  against a config that the agent controls (`core.fsmonitor` runs code). Copying objects for each lane also costs disk.
  Rejected.

## Consequences

- The first `fresh` of a root copies the target's history reachable from the base. A shallow fetch is an option for
  large targets.
- Ignored files are not part of a version. `extend` keeps them because it moves the directory. `fork` starts from the
  version, so they are absent. A nested repository (a gitlink) is refused when the lane is sealed.
- `prune` and `diskUse` count lane bytes only. `prune` does not gc the store, because concurrent concerts may be writing
  objects that nothing references yet.
