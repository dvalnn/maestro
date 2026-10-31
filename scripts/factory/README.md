# Factory tick

One pass of the factory (`docs/agents/factory.md`): it routes a settled triage or slice, lands an ok slice as a PR,
files approved splits and reports, then starts one build of a ready issue or else one triage of an intake issue. It
drives maestro through `--json` and the forge through `forge.py` as forge-bot, who also pushes the PR's branch.

It needs maestro `v0.1.0-rc.1` or later on `PATH`, since the triage composition takes a file param, and `jj`, `git`,
`bun` and `just` to land a slice.

```sh
bun scripts/factory/index.ts --milestone v0.1.0 [--preset triage]
```

| Flag          | Does                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `--milestone` | The milestone whose issues it triages and builds                     |
| `--preset`    | The preset each triage concert is performed with, such as `stub`[^p] |

[^p]: A slice concert takes its tier's preset instead.

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
does not start, a slice that does not land, or a factory block it cannot read halts the factory with an open
`factory:halt` issue; close it to resume.
