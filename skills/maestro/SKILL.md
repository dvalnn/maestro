---
name: maestro
description:
  maestro, the CLI that composes and performs agent compositions as concerts. Use when answering a question about
  maestro, setting it up in a project (.maestro/config.yaml), performing, following or recovering a concert, reading its
  exit code, record or changeset, or writing a composition or pack.
---

# maestro

maestro builds a composition into a checked plan with `compose`, which spends nothing, then `perform`s it as a concert.
The concert's agents and checks work in lanes, isolated copies of the target repository, never in the user's checkout.
Results leave as a changeset, a set of patches the user applies.

This skill is the map: enough on every part of maestro to answer a question or pick the next move, and a pointer to
where each part's detail lives. It was checked against maestro 0.1.0-rc.4. When `maestro --version` names another
release, trust `maestro <verb> --help` wherever the two differ.

## Words

- **Composition**: authored code that builds a graph from typed params; `<pack>.<composition>` or a `.ts` file.
- **Compose**: builds the graph and ends in **pre-flight**, the full check before any spend. No side effects.
- **Plan**: what compose prints: node counts, bounds (`up to 3 repo.agent`) and diagnostics.
- **Perform**: the second stage; it starts a **concert** from a plan. A concert has an id, a record and a result.
- **Node instance**: one node within a concert, named like `test`, `loop[0]/repair` or `parMap[risk]/skeptic`.
- **Outcome**: how an instance or a concert ended: `ok`, `rejected`, `failed` or `skipped`.
- **Lane**: an isolated, versioned working copy cut from the target. Each version is `<concert id>.<node instance>`.
- **Changeset**: a lane version's patches, the only way results leave a concert.
- **Profile**: a named agent setup: its runtime (harness, model, thinking level), instructions and limits.
- **Seat**: a composition's slot for an agent; it names a profile, and config may rebind it.
- **Preset**: a named config layer switched per concert with `--preset`; it tunes profiles and rebinds seats.
- **Check**: a named shell command from config (tests, lint, build) run in a lane; its exit code is its verdict.
- **Stub concert**: a concert whose agents are stubs that change nothing, for a rehearsal with no spend.
- **Pack**: an installed directory of compositions, under `$XDG_DATA_HOME/maestro/packs/` or listed in config under
  `packs`.
- **Workspace**: the nearest directory from the cwd up holding `.maestro/`; its config layers over the user's.
- **Data root**: where the record store and concert files live: `$XDG_DATA_HOME/maestro` (default
  `~/.local/share/maestro`), moved by the `dataRoot` config key.
- **Tour**: a slug grouping related concerts, for listing and pruning them together.

## Where to look

| To                                                          | Read                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| Set maestro up in a project, or fix a `CFG.*` or `HOST.*`   | [bootstrap.md](bootstrap.md)                             |
| Perform a composition, follow it and read its result        | [running.md](running.md), section The loop               |
| Rehearse a composition with no spend                        | [running.md](running.md), section Stub concerts          |
| Read a concert's record, an instance, an artifact or a lane | [running.md](running.md), sections Records and Lane refs |
| Show or apply a changeset                                   | [running.md](running.md), section Changesets             |
| Resume, encore, kill or prune                               | [running.md](running.md), section Recover                |
| Write a composition for a shape no pack has                 | [composition.md](composition.md)                         |
| Build a pack, or build on the classics pack's parts         | [packs.md](packs.md)                                     |
| Learn a verb's flags                                        | `maestro --help`, `maestro <verb> --help`                |
| Learn an installed composition's params                     | `maestro rep --json`, `maestro rep <pack>.<composition>` |

A user who wants maestro to drive their tasks through compositions written for each one can switch on the
`/maestro-ultracode` mode.

## Exit codes

| Code | Means                                                                                                          | Next                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0    | Done, or the concert settled `ok`                                                                              | Report the outputs and the changeset                                                                          |
| 1    | The concert settled `failed`, a composition or config does not build, or the command could not do what it said | Read the message or each diagnostic's message and hint; for a `failed` concert, fix the root cause and resume |
| 2    | Usage error: bad arguments on the command line                                                                 | Read the message; fix the command and run it again                                                            |
| 3    | The concert settled `rejected`, or `cs apply` left conflicts                                                   | Report the verdict: the root cause instance and its reason                                                    |
| 124  | `wait --timeout` passed, the concert still running                                                             | Wait again, or `maestro kill <id>` when the user says to                                                      |
| 130  | `perform`, `resume` or `encore` was stopped by Ctrl-C                                                          | `maestro resume <id>`                                                                                         |
| 143  | `perform`, `resume` or `encore` was stopped by SIGTERM                                                         | `maestro resume <id>`                                                                                         |

## Outcomes

- `ok`: the concert did what it was built for.
- `rejected`: a verdict, such as a red check or a verdict agent's no. The concert's reason is its root cause's.
- `failed`: a crash, a broken contract (a timeout, a missing declared output, a cancel) or an agent's
  `blocked: <cause>`. Fix the cause, then resume.
- `skipped`: an instance whose guard was false or whose input was not `ok`; it points at a root cause elsewhere.

## Recover

- **Resume**: `maestro resume <id>` after fixing what failed or rejected. `ok` instances whose inputs and code are
  unchanged are reused; the rest perform again, under the config as it stands now.
- **Encore**: `maestro encore <id>` performs a concert's composition again as a new concert, each agent continuing its
  counterpart's session and told what changed; pass a param flag to change one.
- **Kill**: `maestro kill <id>` stops a running concert, which settles `failed` and can be resumed.
- A `perform` process that is interrupted or dies leaves its concert `failed`, and the concert resumes the same way.
- **Prune**: `maestro prune` deletes concerts with their records and lanes. Prune the concerts you started or the user
  names, by id or by `--tour`.

## The classics pack

maestro's release ships one pack, `classics`:

- `classics.build_then_repair`: builds the request in a fresh lane, repairs while the checks are red, and leaves a
  changeset.
- `classics.panel_review`: reviews a lane version (`--change`) or target commits (`--revs main..feature`) through each
  lens, a skeptic weighing each lens's findings, then consolidates. Lenses run on the `classics/lens` profile's model
  and skeptics on the `classics/skeptic`'s: pick models of different families for the two, since a skeptic of the lens's
  family tends to share its blind spots.
- `classics.repair_until_green`: the repair loop the others use; it is not performed alone.

Installed, it is `<packs dir>/classics`, its `README.md` there. Missing: install it by [bootstrap.md](bootstrap.md),
step 3.

## Ground rules

- The user's checkout stays theirs: maestro never writes it, and applying a changeset waits for the user's yes.
- Before a perform on a paid harness, give the user the plan's `repo.agent` bound as the spend ceiling.
- Secrets live in the environment (`CLAUDE_CODE_OAUTH_TOKEN`, a harness login); params and committed config hold none.
- A pack is code that runs with the user's permissions: install or list under `packs` only packs the user chose.
- Parse `--json` output, which every verb but `cs` takes; the text form is for people.
