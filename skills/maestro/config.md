# Config keys

The keys of a config file, workspace or user. How the files and presets layer is [presets.md](presets.md).

## An annotated config

```yaml
target:
  repo: /home/me/src/shop # absolute path of the repository lanes are cut from
  base: main # optional; else the target's HEAD
  sparse: [packages/shop, packages/ui] # optional: lanes check out only these directories, or { patterns: [...] }
  prepare: # optional: runs in every new lane, in any form a check takes
    run: bun install --frozen-lockfile
    cache: { path: ~/.bun/install/cache, at: /cache, env: BUN_INSTALL_CACHE_DIR } # optional: a host cache, overlaid
  checks:
    test: bun test # short form: one shell line
    lint: [bunx biome check ., bunx tsc --noEmit] # list form: lines in order, the first failing one stops
    build: # long form
      run: cargo build
      hint: the release build # what an agent is told it covers; required for a check an agent runs
      timeout: 20m # a duration: ms, s, m, h or d; none means no limit
      writable: [/home/me/.cargo/registry] # absolute paths bound read-write: toolchain caches, shared locks
      readOnly: [/opt/sdk] # absolute paths bound read-only
      env: { CARGO_TERM_COLOR: never } # set for this check alone

profiles: # tunes profiles by name, over each one's profile.yaml
  builder: { runtime: { harness: claude, model: sonnet, thinking: high } }

seats: # points a seat at another profile, keyed <composition id>/<seat>: the innermost composition the seat runs in
  repair_until_green/builder: builder

packs: [/home/me/packs/mine] # a pack outside the packs directory; absolute: paths are not expanded

caps:
  repo.agent: 12 # compose refuses a plan that may start more than 12 agents: a spend guard

# limits: { timeout: 2h, tokens: 2000000 } # the whole concert's ceiling, not a profile's: past one it settles failed

sandbox:
  readOnly: [/home/me/docs] # bound read-only into every agent and check
  path: [/home/me/.cargo/bin] # put first on every sandboxed PATH, and bound read-only; belongs in the user config

classics: # composition params, under <pack>: <composition>: <param>
  build_then_repair:
    maxRepairs: 3
```

`concurrency` is optional too. Quote a YAML value that would read as another type or break the line: `"true"`, `"3"`, a
line holding `: ` or ` #`.

## Checks

- Each line runs in its own `sh -c` in the lane, sandboxed: shell variables and `cd` do not carry to the next line.
- A line's exit code is its verdict. Exits 3, 124 (timeout), 127 (not found) and 137 (killed) read as a broken check:

  | Exit                    | Outcome    |
  | ----------------------- | ---------- |
  | 0                       | `ok`       |
  | 3, 124, 127, 137        | `failed`   |
  | any other non-zero exit | `rejected` |

- An agent sees a check's `hint`, never its command.
- `MAESTRO_LANE_BASE`, seen by every check and prepare line (over an `env` entry of that name), is the commit the lane
  was cut from: a check judging only the change runs `git diff $MAESTRO_LANE_BASE`. `HEAD` is the lane's latest version.
- An agent running `check` mid-work has new files untracked (`git add` is denied in its sandbox), which that diff
  misses: list them with `git ls-files --others --exclude-standard`.
- `MAESTRO_CHECK_OUTPUT` is an empty writable directory outside the lane, for reports, build logs or a baseline. The
  check node keeps it as its `output` artifact, pass or fail; an agent's `check` command gets a fresh one, discarded.

## Prepare

`target.prepare` runs in the sandbox, network included, in every lane checked out from a commit, before the node's work.
What it makes must be ignored by the repository's `.gitignore`; any other change, or a non-zero exit, fails the node.

Its `cache: { path, at, env }` overlays a host package cache (`path`, absolute or `~/`) at `at`, writes dying with the
sandbox, and `env` names `at` to the lines. Without `path` on disk or bwrap 0.10+, prepare runs without it. Lanes trust
what the cache holds.

## Sparse

`target.sparse` lists directories relative to the repository root (git's cone mode), or `{ patterns: [...] }` of
gitignore-style patterns when directories cannot say it: `/*`, `!/docs/`, `/docs/api.md` for the root files and one file
under `docs/`. Lanes check out only those, before prepare runs; checks and agents see nothing else.

## Sandbox path

Every sandboxed process's `PATH` is `sandbox.path` in order, then `/usr/bin:/bin`, each bound read-only with no
`sandbox.readOnly` entry. The paths are machine-specific, so they belong in the user file. A check's or prepare's own
`env.PATH` wins over it.

## Packs

Every directory under `$XDG_DATA_HOME/maestro/packs/` is installed with no config. A pack kept elsewhere goes under
`packs`: its directory, absolute or, in a workspace file, relative to the workspace root. To add to the user file's
packs rather than replace them, write `packs: !append [<dir>]`.
