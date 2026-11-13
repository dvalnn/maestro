# Install

For whoever installs maestro on a Linux machine: install, first run, upgrade, uninstall.

maestro ships from [GitHub releases](https://github.com/dvalnn/maestro/releases) as a standalone Linux binary, package
tarballs for authoring, a pack and two skills for Claude Code, Codex and pi. Nothing is published to a public registry.

## 1. Requirements

- Linux x64 with glibc. Hosts of RHEL 8 class are best-effort.
- bubblewrap, with unprivileged user namespaces enabled.
- bash at `/bin/bash`. Every sandbox runs under it, and none starts without it.
- git 2.40 or newer.
- A harness at the version the release supports, which the install script names: pi logged in (`~/.pi/agent`), or Claude
  Code with `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, exported in the shell or set in
  `~/.config/maestro/.env` (`$XDG_CONFIG_HOME/maestro/.env`) as `CLAUDE_CODE_OAUTH_TOKEN=<token>`. The shell's value
  wins over the file's. Another version may emit runs maestro misreads; [mise](https://mise.jdx.dev) pins one per user
  or per project, as in `mise use -g pi@<version>`.

Running maestro needs no Bun.

## 2. Install

```sh
curl -fsSL https://raw.githubusercontent.com/dvalnn/maestro/next/install.sh | sh
```

The script installs the newest stable release, and the same command updates an installed maestro. Set
`MAESTRO_CHANNEL=rc` before `sh` for the newest release, `-rc.<n>` pre-releases included:

```sh
curl -fsSL https://raw.githubusercontent.com/dvalnn/maestro/next/install.sh | MAESTRO_CHANNEL=rc sh
```

Set `MAESTRO_VERSION` to a tag, `v` included, to pin a release. A pin wins over the channel:

```sh
curl -fsSL https://raw.githubusercontent.com/dvalnn/maestro/next/install.sh | MAESTRO_VERSION=v0.2.0-rc.3 sh
```

The script needs `curl` and `sha256sum`, checks every asset against `SHA256SUMS` before touching anything, and refuses
while a concert is running. It then warns about each missing requirement and each harness at another version than the
release supports, and on a terminal offers to pin those harnesses with `mise use -g`. Every command that changes the
machine is appended to `$XDG_STATE_HOME/maestro/install.log`, `~/.local/state/maestro/install.log` by default.

| Installed                                | Where                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| The binary                               | `~/.local/bin/maestro`                                                                  |
| The classics pack                        | `$XDG_DATA_HOME/maestro/packs/classics`                                                 |
| The skills                               | `maestro` and `maestro-ultracode` in `~/.claude/skills` and `~/.agents/skills`[^agents] |
| The four package tarballs, for authoring | `$XDG_DATA_HOME/maestro/sdk/`                                                           |

[^agents]: `~/.agents/skills` is the directory Codex and pi read.

`XDG_DATA_HOME` defaults to `~/.local/share`; a relative value is ignored. The pack, each skill directory and the
package tarballs are replaced. `~/.local/bin` must be on `PATH`, and the script warns when it is not; if
`maestro --version` prints something else, another `maestro` comes first.

Every directory in `$XDG_DATA_HOME/maestro/packs` is a pack, with no `packs` entry in config. `maestro rep` lists them.

## 3. Install by hand

The fallback when the script cannot run. Download the assets of a release into one directory, then:

```sh
sha256sum -c SHA256SUMS
gzip -dc maestro-linux-x64.gz > maestro-linux-x64
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

## 4. Configure

Config layers, keys and presets are in [`packages/cli/README.md`](packages/cli/README.md); the `target` (with
`target.prepare` and `target.sparse`) and `profiles` keys are in the
[host-repo README](packages/host-repo/README.md#configuration), and a profile's `model` and `thinking` in its
[Fields](packages/host-repo/README.md#fields). Two files cover a first run:

- `~/.config/maestro/config.yaml` sets each profile's `runtime`. The classics pack ships ten profiles and no models; its
  [README](packs/classics/README.md) says which composition uses which. Model ids below are placeholders.
- `.maestro/config.yaml` in the target repository names the repo, its base and its checks.

```yaml
# ~/.config/maestro/config.yaml
profiles:
  classics/scout: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/planner: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/builder: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/lens: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/deep-lens: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/top-lens: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
  classics/cross-lens: { runtime: { harness: pi, model: <provider>/<model>, thinking: high } }
  classics/skeptic: { runtime: { harness: pi, model: <provider>/<model>, thinking: high } }
  classics/tester: { runtime: { harness: pi, model: <provider>/<model>, thinking: high } }
  classics/consolidator: { runtime: { harness: claude, model: <claude-model>, thinking: high } }
```

```yaml
# .maestro/config.yaml, in the target repository
target:
  repo: .
  base: main
  checks:
    test: "bun test"
```

To spend nothing first, add a preset that moves every profile to the built-in `stub` harness, then run with
`--preset stub`; `build_then_repair`, `panel_review` and `review_change` end ok, the last two with a tally that upholds
nothing:

```yaml
# .maestro/presets/stub.yaml
profiles:
  "*": { runtime: !replace { harness: stub } }
```

Compose to check the composition, then perform:

```sh
maestro compose classics.build_then_repair --request "<what to build>"
maestro perform classics.build_then_repair --request "<what to build>"
```

## 5. Upgrade

Run the install command again, after letting running concerts settle or stopping them with `maestro kill`. Config keys
may change between releases: read the release notes.

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

Left in place: concerts and their record under `$data`, other packs in `$data/packs`, the config in `~/.config/maestro`,
and the install log in `~/.local/state/maestro`. Remove those too to forget them.

## 7. Authoring packs (needs Bun)

A `package.json` takes the tarballs in `$XDG_DATA_HOME/maestro/sdk/` as `file:` dependencies and again under
`overrides`, so no `@maestro/*` package is fetched from a registry. Paths are absolute; `~` is not expanded:

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

`@maestro/classics` is needed only by a composition built on the classics pack's parts. Rerun `bun install` after an
upgrade.

Bundling a pack and writing its manifest are in the maestro skill's `packs.md`.
