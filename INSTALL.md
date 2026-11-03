# Install

maestro ships from the private forge as a standalone Linux binary, package tarballs for authoring, a pack and two skills
for Claude Code, Codex and pi. Nothing is published to a public registry.

## 1. Requirements

- Linux x64 with glibc. Hosts of RHEL 8 class are best-effort.
- bubblewrap, with unprivileged user namespaces enabled.
- git 2.40 or newer.
- A harness: pi 1.3.0 logged in (`~/.pi/agent`), or Claude Code 2.1.302 with `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`, exported in the shell or set in `~/.config/maestro/.env` (`$XDG_CONFIG_HOME/maestro/.env`) as
  `CLAUDE_CODE_OAUTH_TOKEN=<token>`. The shell's value wins over the file's.

Running maestro needs no Bun.

## 2. Install

```sh
curl -fsSL https://git.amorimcasa.org/tiago/maestro/raw/branch/main/install.sh | sh
```

The script installs the newest stable release, and the same command updates an installed maestro. To install the newest
release, pre-releases (`-rc.<n>` release candidates) included, set `MAESTRO_CHANNEL=rc` before `sh`:

```sh
curl -fsSL https://git.amorimcasa.org/tiago/maestro/raw/branch/main/install.sh | MAESTRO_CHANNEL=rc sh
```

To pin a release, set `MAESTRO_VERSION` to its tag, `v` included, before `sh`. A pin wins over the channel:

```sh
curl -fsSL https://git.amorimcasa.org/tiago/maestro/raw/branch/main/install.sh | MAESTRO_VERSION=v0.1.0-rc.4 sh
```

The script needs `curl` and `sha256sum`, checks every asset against `SHA256SUMS` before touching anything, and refuses
while a concert is running: wait for it to settle, or `maestro kill <id>`.

| Installed                                | Where                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| The binary                               | `~/.local/bin/maestro`                                                                  |
| The classics pack                        | `$XDG_DATA_HOME/maestro/packs/classics`                                                 |
| The skills                               | `maestro` and `maestro-ultracode` in `~/.claude/skills` and `~/.agents/skills`[^agents] |
| The four package tarballs, for authoring | `$XDG_DATA_HOME/maestro/sdk/`                                                           |

[^agents]: `~/.agents/skills` is the directory Codex and pi read.

`XDG_DATA_HOME` defaults to `~/.local/share`. The pack, each skill directory and the package tarballs are replaced.
`~/.local/bin` must be on `PATH`, and the script warns when it is not. If `maestro --version` prints something else,
another `maestro` comes first.

Every directory in `$XDG_DATA_HOME/maestro/packs` is a pack, and no `packs` entry in config is needed. `maestro rep`
lists the installed packs and their compositions.

## 3. Install by hand

The fallback when the script cannot run. Download the assets of a release into one directory, then:

```sh
sha256sum -c SHA256SUMS
install -D -m 755 maestro-linux-x64 ~/.local/bin/maestro
data="${XDG_DATA_HOME:-$HOME/.local/share}/maestro"
for root in ~/.claude/skills ~/.agents/skills; do rm -rf "$root/maestro" "$root/maestro-ultracode"; done
rm -rf "$data/packs/classics"
mkdir -p "$data/packs" "$data/sdk" ~/.claude/skills ~/.agents/skills
tar -xzf classics-*.tar.gz -C "$data/packs"
tar -xzf maestro-skill.tar.gz -C ~/.claude/skills
tar -xzf maestro-skill.tar.gz -C ~/.agents/skills
rm -f "$data"/sdk/maestro-*.tgz
for package in ir sdk host-repo-sdk classics; do cp maestro-"$package"-[0-9]*.tgz "$data/sdk/maestro-$package.tgz"; done
```

A relative `XDG_DATA_HOME` is ignored, by the script and by maestro, which use `~/.local/share` instead.

## 4. Configure

Config keys are in [`packages/cli/README.md`](packages/cli/README.md).

- The user file `~/.config/maestro/config.yaml` holds `profiles` and the pack's params, and `packs` for a pack kept
  outside the packs directory. `packs` may instead go in a workspace's `.maestro/config.yaml`. `~` is not expanded; a
  relative path resolves against the directory of the user file, and in a workspace file or preset against the workspace
  root, the directory that holds `.maestro/`.
- A workspace file `.maestro/config.yaml` per target holds `target: { repo, base, checks }`, and optionally `prepare`
  (lines run on each checked-out lane, such as a dependency install) and `sparse` (directories, or `{ patterns }` of
  gitignore-style patterns, a lane checks out).
- A preset `.maestro/presets/stub.yaml` moves the profiles' runtimes to the built-in `stub` harness, which writes a
  placeholder for each declared output and replies ok. Run with `--preset stub` to spend nothing: `build_then_repair`
  and `panel_review` end ok, the latter with an unapproved verdict.

The classics pack ships seven profiles and no models, and its [README](packs/classics/README.md) holds each
composition's profiles and params: `scout`, `planner`, `builder`, `lens`, `skeptic`, `consolidator` and `documenter`.
`build_then_repair` needs only `builder`, `panel_review` needs `lens`, `skeptic` and `consolidator`, and `scout`,
`planner` and `documenter` serve compositions that build on the pack's seats. A profile holds its instructions and
limits; config sets its `runtime`. Model ids below are placeholders; use your own.

```yaml
# ~/.config/maestro/config.yaml
profiles:
  classics/scout: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/planner: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/builder: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/lens: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/skeptic: { runtime: { harness: pi, model: <provider>/<model>, thinking: high } }
  classics/consolidator: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/documenter: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
```

- Claude: `harness: claude`, `model: sonnet` or `opus`, `thinking` as Claude's `--effort`.
- pi: `harness: pi`, `model: <provider>/<model>` such as `github-copilot/gpt-5-mini`, `thinking` as pi's `--thinking`.
- `panel_review` alone runs lenses on the `classics/lens` profile's model and skeptics on the `classics/skeptic`'s. Pick
  models of different families for the two, since a skeptic of the lens's family tends to share its blind spots.

```yaml
# .maestro/config.yaml, in the target repository
target:
  repo: .
  base: main
  checks:
    test: "bun test"
```

```yaml
# .maestro/presets/stub.yaml
profiles:
  "*": { runtime: !replace { harness: stub } }
```

Compose before performing, then perform:

```sh
maestro compose classics.build_then_repair --request "<what to build>"
maestro perform classics.build_then_repair --request "<what to build>"
```

## 5. Upgrade

Run the install command again, after letting running concerts settle or stopping them with `maestro kill`. Config stays.

An installed classics pack from before profiles must be reinstalled, by that command, to gain its `profiles/`; until
then its seats find no profile. A concert recorded before profiles cannot be resumed: perform it anew.

A record with a changed schema is refused with a message naming `record.db`: move it aside, as the message says. A pack
with a new code hash makes a resumed concert rerun its code nodes.

## 6. Uninstall

Settle or `maestro kill` any running concert, then remove each path the script wrote:

```sh
data="${XDG_DATA_HOME:-$HOME/.local/share}/maestro"
rm -f ~/.local/bin/maestro
rm -rf "$data/packs/classics" "$data/sdk"
for root in ~/.claude/skills ~/.agents/skills; do rm -rf "$root/maestro" "$root/maestro-ultracode"; done
```

Left in place, since they are yours and not written by the script: concerts and their record under `$data`, other packs
in `$data/packs`, and the config in `~/.config/maestro`. Remove `$data` and that directory too to forget them.

## 7. Authoring packs (needs Bun)

A `package.json` takes the package tarballs as `file:` dependencies, and the same ones under `overrides`, so no
`@maestro/*` package is fetched from a registry. The paths are absolute, `~` is not expanded, and name the version-less
tarballs the install put in `$XDG_DATA_HOME/maestro/sdk/`, which each upgrade replaces in place:

```json
{
  "dependencies": {
    "@maestro/ir": "file:/home/me/.local/share/maestro/sdk/maestro-ir.tgz",
    "@maestro/sdk": "file:/home/me/.local/share/maestro/sdk/maestro-sdk.tgz",
    "@maestro/host-repo-sdk": "file:/home/me/.local/share/maestro/sdk/maestro-host-repo-sdk.tgz",
    "@maestro/classics": "file:/home/me/.local/share/maestro/sdk/maestro-classics.tgz"
  },
  "overrides": {
    "@maestro/ir": "file:/home/me/.local/share/maestro/sdk/maestro-ir.tgz",
    "@maestro/sdk": "file:/home/me/.local/share/maestro/sdk/maestro-sdk.tgz",
    "@maestro/host-repo-sdk": "file:/home/me/.local/share/maestro/sdk/maestro-host-repo-sdk.tgz",
    "@maestro/classics": "file:/home/me/.local/share/maestro/sdk/maestro-classics.tgz"
  }
}
```

`@maestro/classics` is needed only by a composition that builds on the classics pack's parts. Rerun `bun install` after
an upgrade to pick up the new tarballs.

Bundling a pack and writing its manifest are in the maestro skill's `packs.md`.

## 8. Known limits

- Linux x64 only.
- Packs are operator-trusted code.
