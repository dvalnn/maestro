# Install

maestro ships from the private forge as a standalone Linux binary, package tarballs for authoring, a pack and a skill.
Nothing is published to a public registry.

## 1. Requirements

- Linux x64 with glibc. Hosts of RHEL 8 class are best-effort.
- bubblewrap, with unprivileged user namespaces enabled.
- git 2.40 or newer.
- A harness: pi 1.3.0 logged in (`~/.pi/agent`), or Claude Code 2.1.302 with `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`, set in the shell or in a `.env` in the cwd.

Running maestro needs no Bun.

## 2. Download and verify

Download the release assets into one directory and check them:

```sh
sha256sum -c --ignore-missing SHA256SUMS
```

| Asset                                                                                          | Holds                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| `maestro-linux-x64`                                                                            | The binary.                          |
| `repertoire-<version>.tar.gz`                                                                  | The repertoire pack.                 |
| `maestro-skill.tar.gz`                                                                         | The maestro skill.                   |
| `maestro-ir-<version>.tgz`, `maestro-sdk-<version>.tgz`, `maestro-host-repo-sdk-<version>.tgz` | The packages for authoring (step 6). |
| `SHA256SUMS`                                                                                   | The checksums.                       |

## 3. Install

```sh
install -D -m 755 maestro-linux-x64 ~/.local/bin/maestro
maestro --version
mkdir -p ~/.local/share/maestro/packs
tar -xzf repertoire-0.1.0-beta.1.tar.gz -C ~/.local/share/maestro/packs
mkdir -p ~/.claude/skills
tar -xzf maestro-skill.tar.gz -C ~/.claude/skills
```

`~/.local/bin` must be on `PATH`. If `maestro --version` prints something else, another `maestro` comes first.

## 4. Configure

Config keys are in [`packages/cli/README.md`](packages/cli/README.md).

- The user file `~/.config/maestro/config.yaml` holds `packs` and `roles`. Paths are not expanded, so write the absolute
  path, such as `/home/me/.local/share/maestro/packs/repertoire`. `packs` lists the pack's path. `roles` names the
  repertoire's roles, with one sample per harness:
  - Claude: `harness: claude`, `model: sonnet` or `opus`, `thinking` as Claude's `--effort`.
  - pi: `harness: pi`, `model: <provider>/<model>` such as `github-copilot/gpt-5-mini`, `thinking` as pi's `--thinking`.
- The `review` composition's lens and skeptic model params go under `repertoire.review`, from different model families.
- A workspace file `.maestro/config.yaml` per target holds `target: { repo: <absolute path>, base, checks }`.
- A profile `.maestro/profiles/stub.yaml` sets the same roles to `harness: stub, model: none`. Run with `--profile stub`
  to spend nothing.

<!-- TODO(part 2): the repertoire's role names and review params, and a sample file for each harness. -->

Compose before performing: `maestro compose repertoire.<composition>`.

## 5. Upgrade

1. Let running concerts settle, or `maestro kill` them.
2. Reinstall the binary over the old one.
3. Replace the pack and skill directories: `rm -rf` the old directory, then extract, so removed files do not linger.
4. Config stays.

A record with a changed schema is refused with a message naming `record.db`: move it aside, as the message says. A pack
with a new code hash makes a resumed concert rerun its code nodes.

## 6. Authoring packs (needs Bun)

A `package.json` takes the three package tarballs as `file:` dependencies, and the same three under `overrides`, so no
`@maestro/*` package is fetched from a registry:

```json
{
  "dependencies": {
    "@maestro/ir": "file:/abs/path/maestro-ir-0.1.0-beta.1.tgz",
    "@maestro/sdk": "file:/abs/path/maestro-sdk-0.1.0-beta.1.tgz",
    "@maestro/host-repo-sdk": "file:/abs/path/maestro-host-repo-sdk-0.1.0-beta.1.tgz"
  },
  "overrides": {
    "@maestro/ir": "file:/abs/path/maestro-ir-0.1.0-beta.1.tgz",
    "@maestro/sdk": "file:/abs/path/maestro-sdk-0.1.0-beta.1.tgz",
    "@maestro/host-repo-sdk": "file:/abs/path/maestro-host-repo-sdk-0.1.0-beta.1.tgz"
  }
}
```

Bundling a pack and writing its manifest are in the skill's `packs.md`.

## 7. Known limits

- Linux x64 only.
- Packs are operator-trusted code.
- A `.env` in the cwd is loaded.
