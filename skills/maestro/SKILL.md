---
name: maestro
description:
  maestro, the CLI that composes and performs agent compositions as concerts. Use when answering a question about
  maestro, setting it up in a project (.maestro/config.yaml), performing, following or recovering a concert, reading its
  exit code, record or changeset, or writing a composition or pack.
---

# maestro

maestro builds a composition into a checked plan with `compose`, which spends nothing, then `perform`s it as a concert.
Its agents and checks work in lanes, never in the user's checkout; results leave as a changeset the user applies.

Checked against maestro 0.2.0-rc.2. Where `maestro --version` names another release, trust `maestro <verb> --help`.

## Words

- **Composition**: authored code that builds a graph from typed params; `<pack>.<composition>` or a `.ts` file.
- **Compose**: builds the graph and ends in **pre-flight**, the full check before any spend. No side effects.
- **Plan**: what compose prints: node counts, bounds (`up to 3 repo.agent`) and diagnostics.
- **Perform**: starts a **concert** from a plan. A concert has an id, a record and a result.
- **Node instance**: one node within a concert, named like `test`, `loop[0]/repair` or `parMap[risk]/skeptic`.
- **Outcome**: how an instance or a concert ended: `ok`, `rejected`, `failed` or `skipped`.
- **Lane**: an isolated, versioned working copy cut from the target. Each version is `<concert id>.<node instance>`.
- **Changeset**: a lane version's patches, the only way results leave a concert.
- **Profile**: a named agent setup: its runtime (harness, model, thinking level), instructions and limits.
- **Seat**: a composition's slot for an agent; it names a profile, and config may rebind it.
- **Check**: a named shell command from config (tests, lint, build) run in a lane; its exit code is its verdict.
- **Preset**: a named config layer switched per concert with `--preset`.
- **Stub concert**: a concert whose agents change nothing, for a rehearsal with no spend.
- **Pack**: an installed set of compositions. The release ships `classics`; its `README.md` and `maestro rep classics`
  describe it.
- **Workspace**: the nearest directory from the cwd up holding `.maestro/`; its config layers over the user's.
- **Tour**: a slug grouping related concerts, for listing and pruning them together.

## Where to look

| To                                                             | Read                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| Set maestro up in a project, or fix a `CFG.*` or `HOST.*`      | [bootstrap.md](bootstrap.md)                             |
| Write or change a config key: target, checks, prepare, sandbox | [config.md](config.md)                                   |
| Layer config: a preset, a `-c` flag, `!append`, `!delete`      | [presets.md](presets.md)                                 |
| Give a profile a harness and model, inspect or probe it        | [profiles.md](profiles.md)                               |
| Perform a composition, follow it and read its result           | [perform.md](perform.md)                                 |
| Rehearse a composition with no spend                           | [stub.md](stub.md)                                       |
| Read a concert's instances, artifacts, lanes or data root      | [records.md](records.md)                                 |
| Show or apply a changeset                                      | [changesets.md](changesets.md)                           |
| Resume, encore, kill, prune or tour concerts                   | [recover.md](recover.md)                                 |
| Write a composition for a shape no pack has                    | [composition.md](composition.md)                         |
| Look up an SDK call, a seat's options or a code node's `ctx`   | [sdk.md](sdk.md)                                         |
| Write an agent's task prompt or profile instructions           | [prompts.md](prompts.md)                                 |
| Build a pack, or build on the classics pack's parts            | [packs.md](packs.md)                                     |
| Learn a verb's flags                                           | `maestro --help`, `maestro <verb> --help`                |
| Learn an installed composition's params                        | `maestro rep --json`, `maestro rep <pack>.<composition>` |

For a user who wants every task driven through a composition written for it, point at the `/maestro-ultracode` mode.

## Exit codes and outcomes

| Code    | Means                                                                    | Next                                                 |
| ------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| 0       | Done, or the concert settled `ok`                                        | Report the outputs and the changeset                 |
| 1       | The concert settled `failed`, or a composition, config or command failed | Read the message and hints; fix the cause and resume |
| 2       | Usage error                                                              | Fix the command                                      |
| 3       | The concert settled `rejected`, or `cs apply` left conflicts             | Report the root cause instance and its reason        |
| 124     | `wait --timeout` passed, the concert still running                       | Wait again                                           |
| 130/143 | `perform`, `resume` or `encore` was stopped by Ctrl-C or SIGTERM         | `maestro resume <id>`                                |

- `rejected` is a verdict: a red check or a verdict agent's no. The concert's reason is its root cause's.
- `failed` is a crash, a broken contract (a timeout, a missing declared output, a cancel) or an agent's
  `blocked: <cause>`. Fix the cause, then resume.
- `skipped` is an instance whose guard was false or whose input was not `ok`; its root cause is elsewhere.

## Ground rules

- The user's checkout stays theirs: maestro never writes it, and applying a changeset waits for the user's yes.
- Before a perform on a paid harness, give the user the plan's `repo.agent` bound as the spend ceiling.
- Kill a concert, or prune one, only when you started it or the user names it.
- Secrets live in the environment (`CLAUDE_CODE_OAUTH_TOKEN`, a harness login); params and committed config hold none.
- A pack is code that runs with the user's permissions: install or list under `packs` only packs the user chose.
- Parse `--json` output, which every verb but `cs` takes; the text form is for people.
