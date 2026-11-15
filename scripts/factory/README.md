# Factory tick

One tick of the tour manager (`docs/agents/factory.md`): it routes a settled triage or slice, lands an ok slice as a PR,
files approved splits, then starts at most one concert in a free slot, a triage or masterclass beside a build (the two
slots and their pick order: `docs/agents/factory.md`, Rules, Policy: One concert per slot). It routes a settled
masterclass by filing its proposals as `needs-approval` issues. A masterclass reads every run that settled at or after
the start of the last ok masterclass, however far back it started, then the newest read runs up to 30 in all
([Masterclass](../../docs/agents/factory.md#masterclass)). A build continues the issue's last slice concert when it has
a reply to feed it. It drives maestro through `--json` and calls the forge's REST API directly as its own account,
`maestro-tm`, which also force-pushes the PR's branch, and authors (and, with a key, signs) the commits it lands. A
triage reads only the tour manager's question comments and comments mentioning its login, which each tick reads from
`GET /user`.

A ticket with an open dependency is neither triaged nor built until every dependency closes, so a spec is written
against real `main` and every PR targets it. On a low-risk PR to `main` whose review left no findings upheld the tick
arms the forge's auto-merge, fast-forward only, so the commits keep their signature; it never merges by hand, so
`main`'s branch protection must require the `check` status for the merge to wait on CI.

It needs maestro `v0.1.0-rc.4` or later on `PATH`, since it calls `encore`, `artifact ls` and `--detach`, and `jj`,
`git`, `bun` and `just` to land a slice. It needs no python or `fj`.

It reads `$XDG_CONFIG_HOME/maestro/.env` (`~/.config` by default) when that exists, as maestro does, and a variable
already set wins over the file:

| Key                      | Does                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `MAESTRO_TM_TOKEN`       | The `maestro-tm` account's API token; required, else it exits 1 naming it                                                |
| `MAESTRO_TM_SIGNING_KEY` | Path of an SSH key that signs its commits; unset leaves them unsigned, a missing file exits 1                            |
| `MAESTRO_TM_MILESTONE`   | The milestone whose issues it triages and builds; required unless `--milestone` is passed, else it exits 1 naming it[^m] |

[^m]: Moving to the next release is editing this value.

The host, owner and repo come from the `origin` remote (ssh or https). The account needs write access to the repo, which
lets it push branches, open PRs, comment, request reviews, label, file issues and arm auto-merge; give it no admin
right. Its login, name and email come from `GET /user` and author every commit the tick describes. The systemd unit
needs no new `Environment=`, since the keys live in the `.env`.

A PR that conflicts with `main` is encored from its merge onto it and lands rebased, and the tick answers a PR it
revises; see `docs/agents/factory.md`, Rules, Build: Encore and Landing and PRs.

```sh
bun scripts/factory/index.ts [--milestone v0.1.0] [--preset xscout]... [--route-only]
```

| Flag           | Does                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `--milestone`  | The milestone whose issues it triages and builds; overrides `MAESTRO_TM_MILESTONE` for that tick        |
| `--preset`     | A preset each triage, build and masterclass is performed with, such as `stub`; repeatable, in order[^p] |
| `--route-only` | Routes settled concerts and syncs, then starts no build, triage or masterclass                          |

[^p]:
    A build layers them last, after its risk's preset and its area's; a triage and a masterclass layer them after the
    `triage` preset, which they name themselves. An area preset is an optional file,
    `.maestro/presets/area-<area>.yaml`, whose content grows from the masterclass.

It exits 0 when it acted or had nothing to do, 1 when the forge or maestro failed, its config is missing a key, the
milestone does not exist or a concert's tree cannot be made (the next tick retries) and 2 on a bad flag. It keeps its
lock, backlog snapshots and perform logs in `$XDG_RUNTIME_DIR/maestro-factory/`, lands each slice in a jj workspace
under `$XDG_CACHE_HOME/maestro-factory/`, and performs each fresh concert in a workspace of `main`, and an encore in the
workspace of its first concert's commit, each with its own installed dependencies, in
`$XDG_CACHE_HOME/maestro-factory/trees/<commit>/` (`docs/agents/factory.md`, Rules, Landing and PRs: Compositions).

## Install

The tick runs from its own jj clone, `~/.local/share/maestro-factory/repo`, never from a dev checkout. Each tick moves
the clone to origin's `main` and installs its dependencies, so it runs only pushed code and a PR that changes
dependencies cannot strand it. The clone is the factory's own: nobody works in it. Once, by hand:

```sh
jj git clone --colocate <origin url> ~/.local/share/maestro-factory/repo
(cd ~/.local/share/maestro-factory/repo && mise trust)
```

The units run a tick every 5 minutes. Edit `PATH` and the flags in the service to suit the machine; the milestone is set
in the `.env`, not the unit. Copy the service again after a change to it, then `systemctl --user daemon-reload`.

```sh
cp scripts/factory/maestro-factory.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now maestro-factory.timer
journalctl --user -u maestro-factory    # what each tick did
```

To stop it, `systemctl --user disable --now maestro-factory.timer`. A failure the tick cannot route halts it with an
open `maestro-tm:halt` issue; close it to resume (`docs/agents/factory.md`, Policy: Halt).

A new environment starts with manual shakedown runs, each watched by hand: first with the stub harness
(`--preset stub`), then with a cheap model. The tick does not enforce them.
