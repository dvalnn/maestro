# Bootstrap

Steps to set maestro up in a project. Done when `maestro compose <c>` exits 0 for the composition the user wants
performed.

## Steps

1. **Prerequisites.** `maestro --help` answers; `bwrap` (bubblewrap) and `git` 2.40 or newer are on `PATH`. Each harness
   a profile names needs its CLI on `PATH` and its credentials:
   - `claude`: `CLAUDE_CODE_OAUTH_TOKEN`, made by `claude setup-token`, in the environment or as a line of
     `$XDG_CONFIG_HOME/maestro/.env` (default `~/.config/maestro/.env`).
   - `pi`: logged in by running `pi` once; its config in `~/.pi/agent`.

   A setup whose profiles are all stub needs no harness. Done when each command answers.

2. **Read the layers that exist** ([presets.md](presets.md)). The user file, `~/.config/maestro/config.yaml`, often
   already lists `packs` and tunes `profiles`. Done when you know which packs, profiles and checks are already set.
3. **Write `.maestro/config.yaml`** at the repository root, holding only what no lower layer sets. Each key's detail is
   in [config.md](config.md):
   - `target.repo`: the repository's absolute path. `target.base` only when the user names a branch or commit.
   - `target.checks`: the project's own test, lint and build commands, found in its manifest (`package.json` scripts,
     `Makefile`, `justfile`, `pyproject.toml`) or its CI file, named `test`, `lint`, `build`. A check an agent runs
     takes a `hint`.
   - `target.prepare`: what a fresh checkout needs before the checks work, such as `bun install` or `uv sync`.
   - `target.sparse`: in a monorepo, the directories the work needs.
   - `profiles`: a `runtime` for every profile the composition's seats name that no layer sets. A model is spend: ask
     the user for its harness and model ([profiles.md](profiles.md)).
   - `sandbox.path`: the directories of the tools checks and agents run (`bun`, `just`, `cargo`), in the user file.
   - Packs: the release ships the classics pack as `classics-<version>.tar.gz` beside the binary. Extracting it into the
     packs directory is the whole install:

     ```sh
     packs="${XDG_DATA_HOME:-$HOME/.local/share}/maestro/packs"
     mkdir -p "$packs" && tar -xzf classics-<version>.tar.gz -C "$packs" && maestro rep
     ```

   Done when every profile, check and pack the composition needs has a value in some layer.

4. **Ignore `.maestro/`.** It sits inside the target repository and must not be committed. Ask the user whether to add
   it to `.gitignore` or to `.git/info/exclude` (local only), then add it. Done when `git status` no longer lists it.
5. **Verify.** `maestro compose <c>`; fix each diagnostic by its hint or the table below, and compose again. Then
   `maestro config <c> [param flags]` shows each value with its layer, file and line. Done when both exit 0.

## Diagnostics a bootstrap meets

Human output reads `error: <message>`; the code, such as `HOST.profile`, shows only under `--json`.

| Message                                                       | Fix                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `error: profile 'r' is in no profile root`                    | Add the profile directory `r`, or set `profiles.r.runtime` where it exists    |
| `error: 'x' runs on harness 'h', which is not loaded`         | Use a harness the hint lists                                                  |
| `error: 'x' runs check 'c', which config 'target.checks' ...` | Add `target.checks.c`                                                         |
| `error: x: check 'c' has no hint, and an agent cannot ...`    | Add `target.checks.c.hint`, in the inline form `{ run, hint }`                |
| `error: target repository '...' does not exist`               | Fix `target.repo`                                                             |
| `error: config 'target' must have required property 'repo'`   | Set `target.repo`, or `cd` into the workspace                                 |
| `error: config key 'k' is claimed by no installed ...`        | Rename it as the did-you-mean hint says, or install its pack                  |
| `error: read-only bind 'p' is not an absolute path`           | Give an absolute path that exists, outside the lanes                          |
| `error: 'repo.agent' may reach at least N, over its cap of M` | Lower the params that size the plan, or ask to raise the cap                  |
| `error: param 'p' (--p) of 'pack.c' is required`              | Pass `--p`, or for a pack's composition set it under `<pack>: <composition>:` |
| `no pack 'x' is installed`                                    | Extract it into the packs directory, or add its directory to `packs`          |
