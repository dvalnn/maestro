# Factory tick

One pass of the tour manager (`docs/agents/factory.md`): it routes a settled triage or slice, lands an ok slice as a PR,
files approved splits and reports, restacks a stacked PR whose dependency merged, then starts one encore of a PR an
official review requested changes on, else one build of a ready issue, else one triage of an intake issue. A build
continues the issue's last slice concert when it has a reply to feed it. It drives maestro through `--json` and calls
the forge's REST API directly as its own account, `maestro-tm`, which also pushes, and on a restack force-pushes, the
PR's branch, and authors (and, with a key, signs) the commits it lands. A triage reads only the tour manager's question
comments and comments mentioning its login, which each pass reads from `GET /user`.

A ticket whose dependencies are all in review builds on the newest one's PR head, and its PR targets that dependency's
branch until the restack moves it to `main`. On a low-risk PR to `main` the tick arms the forge's auto-merge,
fast-forward only, so the commits keep their signature; it never merges by hand, so `main`'s branch protection must
require the `check` status for the merge to wait on CI.

It needs maestro `v0.1.0-rc.2` or later on `PATH`, since a build layers its presets with a repeatable `--preset`, and
`jj`, `git`, `bun` and `just` to land a slice. It needs no python or `fj`.

It reads `$XDG_CONFIG_HOME/maestro/.env` (`~/.config` by default) when that exists, as maestro does, and a variable
already set wins over the file:

| Key                      | Does                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `MAESTRO_TM_TOKEN`       | The `maestro-tm` account's API token; required, else it exits 1 naming it                     |
| `MAESTRO_TM_SIGNING_KEY` | Path of an SSH key that signs its commits; unset leaves them unsigned, a missing file exits 1 |

The host, owner and repo come from the `origin` remote (ssh or https). The account needs write access to the repo, which
lets it push branches, open PRs, comment, label, file issues and arm auto-merge; give it no admin right. Its login, name
and email come from `GET /user` and author every commit the tick describes or restacks. The systemd unit needs no new
`Environment=`, since the keys live in the `.env`.

A low-risk PR whose base moved after it was pushed cannot fast-forward, and stays open for the owner to restack.

```sh
bun scripts/factory/index.ts --milestone v0.1.0 [--preset triage] [--route-only]
```

| Flag           | Does                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| `--milestone`  | The milestone whose issues it triages and builds                       |
| `--preset`     | The preset each triage and build is performed with, such as `stub`[^p] |
| `--route-only` | Routes settled concerts and syncs, then starts no build or triage      |

[^p]:
    A build layers it last, after its tier's preset and its area's. An area preset is an optional file,
    `.maestro/presets/area-<area>.yaml`, whose content grows from the harvest.

It exits 0 when it acted or had nothing to do, 1 when the forge or maestro failed or the milestone does not exist (the
next pass retries) and 2 on a bad flag. It keeps its lock, backlog snapshots and perform logs in
`$XDG_RUNTIME_DIR/maestro-factory/`, and lands each slice in a jj workspace under `$XDG_CACHE_HOME/maestro-factory/`.

## Install

The units run a pass every 5 minutes. Edit `WorkingDirectory`, `PATH` and the flags in the service to suit the machine.

```sh
cp scripts/factory/maestro-factory.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now maestro-factory.timer
journalctl --user -u maestro-factory    # what each pass did
```

To stop it, `systemctl --user disable --now maestro-factory.timer`. A failed or malformed triage, a triage or build that
does not start, a slice that fails without a `blocked:` reason, a slice that does not land, or data it cannot read halts
the tour manager with an open `maestro-tm:halt` issue; close it to resume.
