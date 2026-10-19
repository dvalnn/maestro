# Bootstrap: setting maestro up in a project

Steps to write a project's `.maestro/config.yaml`, then reference: an annotated example, profiles, and the diagnostics a
bootstrap meets. Done when `maestro compose <c>` exits 0 for the composition the user wants performed.

## Steps

1. **Prerequisites.** `maestro --help` prints its commands; `bwrap` (bubblewrap) and `git` 2.40 or newer are on `PATH`.
   Each harness a role names needs its CLI on `PATH` and its credentials:
   - `claude`: `CLAUDE_CODE_OAUTH_TOKEN` in the environment or in a `.env` file in the directory maestro runs from; made
     by `claude setup-token`.
   - `pi`: pi logged in, its config in `~/.pi/agent`; made by running `pi` once and logging in.

   A setup whose roles are all stub needs no harness. Done when each command answers.

2. **Read the layers that exist.** Config layers, lowest first: the user file `$XDG_CONFIG_HOME/maestro/config.yaml`
   (default `~/.config/maestro/config.yaml`), the workspace file `.maestro/config.yaml`, then a profile. The user file
   often already lists `packs` and maps `roles`. Done when you know which packs, roles and checks are already set.
3. **Write `.maestro/config.yaml`** at the repository root, holding only what no lower layer sets:
   - `target.repo`: the repository's absolute path. `target.base`: a branch or commit, only when the user names one;
     lanes are cut from the target's `HEAD` otherwise.
   - `target.checks`: the project's own test, lint and build commands, found in its manifest (`package.json` scripts,
     `Makefile`, `justfile`, `pyproject.toml`) or its CI file. Name them for what they do: `test`, `lint`, `build`.
   - `target.prepare`: the commands a fresh checkout needs before those commands work, such as a dependency install
     (`bun install`, `uv sync`), in a check's forms. It runs in the sandbox, network included, in every lane checked out
     from a commit, before the node's work. What it makes must be ignored by the repository's `.gitignore`; any other
     change, or a non-zero exit, fails the node.
   - `target.sparse`: in a monorepo, the directories the work needs, relative to the repository root (git's cone mode).
     Lanes check out only those, before prepare runs; checks and agents see nothing else.
   - `roles`: every role the composition names. Compose lists each missing one. A role no layer maps is the user's call,
     since a model is spend: ask the user for its harness and model.
   - `packs`: each installed pack's directory, absolute or relative to the workspace root (the directory that holds
     `.maestro/`) in a workspace file. A list replaces the lower layer's, so to add to the user file's packs write
     `packs: !append [<dir>]`. The release ships the repertoire as `repertoire-<version>.tar.gz` beside the binary;
     install it into the packs directory, then list the printed directory:

     ```sh
     packs="${XDG_DATA_HOME:-$HOME/.local/share}/maestro/packs"
     mkdir -p "$packs" && tar -xzf repertoire-<version>.tar.gz -C "$packs" && echo "$packs/repertoire"
     ```

     ```yaml
     packs: [/home/me/.local/share/maestro/packs/repertoire]
     ```

   - Optional: `caps`, `sandbox.readOnly`, `concurrency`, and composition params (see the example).

   Quote a YAML value that would read as another type or break the line: `"true"`, `"3"`, a line holding `: ` or ` #`.
   Done when every role, check and pack the composition needs has a value in some layer.

4. **Verify.** `maestro compose <c>` and fix each diagnostic it prints by its hint, or by the table below, then compose
   again. Then `maestro config <c> [param flags]` shows each value with its layer, file and line. Done when both exit 0.

## Reference

### An annotated config

```yaml
target:
  repo: /home/me/src/shop # absolute path of the repository lanes are cut from
  base: main # optional; else the target's HEAD
  sparse: [packages/shop, packages/ui] # optional: lanes check out only these directories
  prepare: bun install --frozen-lockfile # optional: runs in every new lane, in any form a check takes
  checks:
    test: bun test # short form: one shell line
    lint: [bunx biome check ., bunx tsc --noEmit] # list form: lines in order, the first failing one stops
    build: # long form
      run: cargo build
      timeout: 20m # a duration: ms, s, m, h or d; none means no limit
      writable: [/home/me/.cargo/registry] # absolute paths bound read-write: toolchain caches, shared locks
      readOnly: [/opt/sdk] # absolute paths bound read-only
      env: { CARGO_TERM_COLOR: never } # set for this check alone

roles:
  builder: { harness: claude, model: sonnet, thinking: high }
  reviewer: { harness: pi, model: anthropic/claude-opus-4-1, thinking: medium }

packs: [/home/me/.local/share/maestro/packs/repertoire] # absolute: paths are not expanded

caps:
  repo.agent: 12 # compose refuses a plan that may start more than 12 agents: a spend guard

sandbox:
  readOnly: [/home/me/docs] # bound read-only into every agent and check

repertoire: # composition params, under <pack>: <composition>: <param>
  build_then_repair:
    maxRepairs: 3
```

Each check line runs through `sh -c` in the lane, in a sandbox. Its exit code is its verdict:

| Exit                    | Outcome    |
| ----------------------- | ---------- |
| 0                       | `ok`       |
| 3, 124, 127, 137        | `failed`   |
| any other non-zero exit | `rejected` |

Exits 3, 124 (a timeout), 127 (command not found) and 137 (killed) read as a broken check, not a verdict.

### Roles and harnesses

| Harness  | `model`                                          | `thinking`             |
| -------- | ------------------------------------------------ | ---------------------- |
| `claude` | an alias such as `sonnet`, or a full model id    | passed as `--effort`   |
| `pi`     | `provider/model`, such as `anthropic/claude-...` | passed as `--thinking` |
| `stub`   | any string; `none` by convention                 | ignored                |

maestro passes model and thinking through unchecked, so confirm an id with the harness's own CLI. A composition may
override a role's harness, model or thinking per agent.

### Profiles

A profile is `.maestro/profiles/<name>.yaml`, layered on top by `--profile <name>` on any verb. Layers merge maps by
key, and a list in a higher layer replaces the lower one. YAML tags change that:

- `!replace` on a map replaces the lower map instead of merging into it.
- `!append` on a list appends to the lower list.
- `!delete` on a key drops it.

```yaml
# .maestro/profiles/cheap.yaml: the builder on a cheaper model; its harness and thinking merge from below
roles:
  builder: { model: haiku }
```

The stub profile, every role on the stub harness, is in SKILL.md, section Stub concerts.

### Diagnostics a bootstrap meets

| Diagnostic                                                          | Fix                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `HOST.role: 'x' takes role 'r', which config 'roles' does not have` | Map `roles.r` (ask the user for harness and model)                            |
| `HOST.harness: 'x' runs on harness 'h', which is not loaded`        | Use a harness the hint lists                                                  |
| `HOST.check: 'x' runs check 'c', which config 'target.checks' ...`  | Add `target.checks.c`                                                         |
| `HOST.target: target repository '...' does not exist`               | Fix `target.repo`                                                             |
| `CFG.schema: config 'target' must have required property 'repo'`    | Set `target.repo`, or `cd` into the workspace                                 |
| `CFG.unclaimed: config key 'k' is claimed by no installed ...`      | Rename it as the did-you-mean hint says, or install its pack                  |
| `HOST.bind: read-only bind 'p' is not an absolute path`             | Give an absolute path that exists, outside the lanes                          |
| `BOUND.cap: 'repo.agent' may reach at least N, over its cap of M`   | Lower the params that size the plan, or ask to raise the cap                  |
| `CFG.required: param 'p' (--p) of 'pack.c' is required`             | Pass `--p`, or for a pack's composition set it under `<pack>: <composition>:` |
| `no pack 'x' is installed`                                          | Add the pack's directory to `packs`                                           |
