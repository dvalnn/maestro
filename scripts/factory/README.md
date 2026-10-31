# Factory tick

One pass of the factory (`docs/agents/factory.md`): it routes a settled triage, files approved splits and starts one
triage of the milestone's intake issues. It drives maestro through `--json` and the forge through `forge.py` as
forge-bot.

```sh
bun scripts/factory/index.ts --milestone v0.1.0 [--preset triage]
```

| Flag          | Does                                                                  |
| ------------- | --------------------------------------------------------------------- |
| `--milestone` | The milestone whose `needs-triage` and `needs-spec` issues it triages |
| `--preset`    | The preset each triage concert is performed with, such as `stub`      |

It exits 0 when it acted or had nothing to do, 1 when the forge or maestro failed or the milestone does not exist (the
next pass retries) and 2 on a bad flag. It keeps its lock, backlog snapshots and perform logs in
`$XDG_RUNTIME_DIR/maestro-factory/`.

## Install

The units run a pass every 5 minutes. Edit `WorkingDirectory`, `PATH` and the flags in the service to suit the machine.

```sh
cp scripts/factory/maestro-factory.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now maestro-factory.timer
journalctl --user -u maestro-factory    # what each pass did
```

To stop it, `systemctl --user disable --now maestro-factory.timer`. A failed or malformed triage, a triage that does not
start, or a factory block it cannot read halts the factory with an open `factory:halt` issue; close it to resume.
