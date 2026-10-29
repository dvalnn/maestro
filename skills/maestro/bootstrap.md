# Bootstrap: setting maestro up in a project

Steps to write a project's `.maestro/config.yaml`, then reference: an annotated example, profiles, and the diagnostics a
bootstrap meets. Done when `maestro compose <c>` exits 0 for the composition the user wants performed.

## Steps

1. **Prerequisites.** `maestro --help` prints its commands; `bwrap` (bubblewrap) and `git` 2.40 or newer are on `PATH`.
   Each harness a profile names needs its CLI on `PATH` and its credentials:
   - `claude`: `CLAUDE_CODE_OAUTH_TOKEN` in the environment or in `$XDG_CONFIG_HOME/maestro/.env` (default
     `~/.config/maestro/.env`) as `CLAUDE_CODE_OAUTH_TOKEN=<token>`; made by `claude setup-token`.
   - `pi`: pi logged in, its config in `~/.pi/agent`; made by running `pi` once and logging in.

   A setup whose profiles are all stub needs no harness. Done when each command answers.

2. **Read the layers that exist.** Config layers, lowest first: the user file `$XDG_CONFIG_HOME/maestro/config.yaml`
   (default `~/.config/maestro/config.yaml`), the workspace file `.maestro/config.yaml`, then a preset `--preset` names,
   then each `-c <key>=<value>` flag. The user file often already lists `packs` and tunes `profiles`. Done when you know
   which packs, profiles and checks are already set.
3. **Write `.maestro/config.yaml`** at the repository root, holding only what no lower layer sets:
   - `target.repo`: the repository's absolute path. `target.base`: a branch or commit, only when the user names one;
     lanes are cut from the target's `HEAD` otherwise.
   - `target.checks`: the project's own test, lint and build commands, found in its manifest (`package.json` scripts,
     `Makefile`, `justfile`, `pyproject.toml`) or its CI file. Name them for what they do: `test`, `lint`, `build`. A
     check an agent runs takes a `hint`, `{ run, hint }`: what it covers, in a few words; the agent sees the hint, never
     the command. Every line of a check, and of `target.prepare`, sees `MAESTRO_LANE_BASE` (overriding an `env` entry of
     that name), the commit its lane was cut from, so a check judging only the change diffs against it, as
     `git diff $MAESTRO_LANE_BASE`; `HEAD` is the lane's latest version. An agent running `check` mid-work has new files
     untracked (`git add` is denied in its sandbox), which that diff misses; list them with
     `git ls-files --others --exclude-standard`. A check's lines also see `MAESTRO_CHECK_OUTPUT`, an empty writable
     directory outside the lane for reports, build logs or a baseline capture; the check node keeps it as its `output`
     artifact, pass or fail (an agent's `check` command gives a fresh one, discarded with the run).
   - `target.prepare`: the commands a fresh checkout needs before those commands work, such as a dependency install
     (`bun install`, `uv sync`), in a check's forms. It runs in the sandbox, network included, in every lane checked out
     from a commit, before the node's work. What it makes must be ignored by the repository's `.gitignore`; any other
     change, or a non-zero exit, fails the node.
   - `target.sparse`: in a monorepo, the directories the work needs, relative to the repository root (git's cone mode),
     or `{ patterns: [...] }` of gitignore-style patterns when directories cannot say it, as `/*`, `!/docs/`,
     `/docs/api.md` for the root files and one file under `docs/`. Lanes check out only those, before prepare runs;
     checks and agents see nothing else.
   - `profiles`: every profile the composition's seats name needs a `runtime` (`harness` and `model`) from the profile's
     own `profile.yaml` or from a layer. Compose lists each missing one. A runtime no layer sets is the user's call,
     since a model is spend: ask the user for its harness and model.
   - Packs: every directory under `$XDG_DATA_HOME/maestro/packs/` is installed, with no config. The release ships the
     classics pack as `classics-<version>.tar.gz` beside the binary; extracting it there is the whole install, and
     `maestro rep` then lists it:

     ```sh
     packs="${XDG_DATA_HOME:-$HOME/.local/share}/maestro/packs"
     mkdir -p "$packs" && tar -xzf classics-<version>.tar.gz -C "$packs" && maestro rep
     ```

     A pack kept elsewhere goes under `packs`: its directory, absolute or relative to the workspace root (the directory
     that holds `.maestro/`) in a workspace file. A list replaces the lower layer's, so to add to the user file's packs
     write `packs: !append [<dir>]`.

   - `sandbox.path`: the absolute directories of the tools checks, `target.prepare` and agents run (`bun`, `just`,
     `cargo`). Every sandboxed process's PATH is those directories in order, then `/usr/bin:/bin`, and each is bound
     read-only, so it needs no `sandbox.readOnly` entry. These paths are machine-specific, so set it in the user config,
     not the workspace file. A check's or prepare's own `env.PATH` wins over it.
   - Optional: `caps`, `sandbox.readOnly`, `concurrency`, and composition params (see the example).

   Quote a YAML value that would read as another type or break the line: `"true"`, `"3"`, a line holding `: ` or ` #`.
   Done when every profile, check and pack the composition needs has a value in some layer.

4. **Ignore `.maestro/`.** The workspace directory sits inside the target repository and must not be committed. Ask the
   user whether to add `.maestro/` to the repository's `.gitignore` or to `.git/info/exclude` (local only), then add it.
   Done when `git status` no longer lists `.maestro/`.
5. **Verify.** `maestro compose <c>` and fix each diagnostic it prints by its hint, or by the table below, then compose
   again. Then `maestro config <c> [param flags]` shows each value with its layer, file and line. Done when both exit 0.

## Reference

### An annotated config

```yaml
target:
  repo: /home/me/src/shop # absolute path of the repository lanes are cut from
  base: main # optional; else the target's HEAD
  sparse: [packages/shop, packages/ui] # optional: lanes check out only these directories, or { patterns: [...] }
  prepare: bun install --frozen-lockfile # optional: runs in every new lane, in any form a check takes
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
  classics/lens: { runtime: { harness: pi, model: anthropic/claude-opus-4-1, thinking: medium } }

packs: [/home/me/packs/mine] # a pack outside the packs directory; absolute: paths are not expanded

caps:
  repo.agent: 12 # compose refuses a plan that may start more than 12 agents: a spend guard

sandbox:
  readOnly: [/home/me/docs] # bound read-only into every agent and check
  path: [/home/me/.cargo/bin] # put first on every sandboxed PATH, and bound read-only; belongs in the user config

classics: # composition params, under <pack>: <composition>: <param>
  build_then_repair:
    maxRepairs: 3
```

Each check line runs in its own `sh -c` in the lane, in a sandbox: shell variables and `cd` do not carry to the next
line. A line's exit code is its verdict:

| Exit                    | Outcome    |
| ----------------------- | ---------- |
| 0                       | `ok`       |
| 3, 124, 127, 137        | `failed`   |
| any other non-zero exit | `rejected` |

Exits 3, 124 (a timeout), 127 (command not found) and 137 (killed) read as a broken check, not a verdict.

### Profiles and harnesses

| Harness  | `model`                                          | `thinking`             |
| -------- | ------------------------------------------------ | ---------------------- |
| `claude` | an alias such as `sonnet`, or a full model id    | passed as `--effort`   |
| `pi`     | `provider/model`, such as `anthropic/claude-...` | passed as `--thinking` |
| `stub`   | any string; `none` by convention                 | ignored                |

maestro passes model and thinking through unchecked, so confirm an id with the harness's own CLI. A composition sets
none of them: a seat names a profile. Per field, `-c` and `--preset` beat the config files' `profiles`, which beat the
profile's own `profile.yaml`, so `--preset stub` always means no spend.

A profile is a directory with a `profile.yaml` (`runtime`, `instructions`, `limits`, `attachments`) and the files it
names, in `.maestro/profiles/<name>/` of the workspace, `$XDG_CONFIG_HOME/maestro/profiles/<name>/` of the user, or a
pack's `profiles/`, as `<pack>/<name>`. The highest of those holding the name wins it whole. `readOnly` is set only in
config, as `profiles.<name>.readOnly`. `maestro agent ls` lists every profile with the root that wins it, and
`maestro agent show <profile>` prints what one resolves to, naming the layer behind each value a config file, preset or
`-c` set.

### Layers

A preset, `<name>.yaml` in `.maestro/presets/` of the workspace or else `$XDG_CONFIG_HOME/maestro/presets/` of the user,
is applied by `--preset <name>` on any verb; the workspace's wins the name whole. Layers merge maps by key, and a list
in a higher layer replaces the lower one. YAML tags change that:

- `!replace` on a map replaces the lower map instead of merging into it.
- `!append` on a list appends to the lower list.
- `!delete` on a key drops it.

```yaml
# .maestro/presets/cheap.yaml: the builder on a cheaper model; its harness and thinking merge from below
profiles:
  builder: { runtime: { model: haiku } }
```

For a one-off change, `-c <key>=<value>` on any verb layers one key over the preset, its value YAML with the same tags:
`-c profiles.builder.runtime.model=haiku`, `-c 'packs=!append [../b]'`, `-c target.checks.lint=!delete`. A key holding a
`.` goes in double quotes. A resume reapplies the concert's `--preset` and `-c`, but finds the record store by today's
`dataRoot`: pass a `-c dataRoot=` again. The record keeps each `-c` as typed, so keep secrets in the `.env`.

The stub preset, every profile on the stub harness, is in SKILL.md, section Stub concerts.

### Diagnostics a bootstrap meets

| Diagnostic                                                         | Fix                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `HOST.profile: profile 'r' is in no profile root`                  | Add the profile directory `r`, or set `profiles.r.runtime` where it exists    |
| `HOST.harness: 'x' runs on harness 'h', which is not loaded`       | Use a harness the hint lists                                                  |
| `HOST.check: 'x' runs check 'c', which config 'target.checks' ...` | Add `target.checks.c`                                                         |
| `HOST.check: x: check 'c' has no hint, and an agent cannot ...`    | Add `target.checks.c.hint`, in the inline form `{ run, hint }`                |
| `HOST.target: target repository '...' does not exist`              | Fix `target.repo`                                                             |
| `CFG.schema: config 'target' must have required property 'repo'`   | Set `target.repo`, or `cd` into the workspace                                 |
| `CFG.unclaimed: config key 'k' is claimed by no installed ...`     | Rename it as the did-you-mean hint says, or install its pack                  |
| `HOST.bind: read-only bind 'p' is not an absolute path`            | Give an absolute path that exists, outside the lanes                          |
| `BOUND.cap: 'repo.agent' may reach at least N, over its cap of M`  | Lower the params that size the plan, or ask to raise the cap                  |
| `CFG.required: param 'p' (--p) of 'pack.c' is required`            | Pass `--p`, or for a pack's composition set it under `<pack>: <composition>:` |
| `no pack 'x' is installed`                                         | Extract it into the packs directory, or add its directory to `packs`          |
