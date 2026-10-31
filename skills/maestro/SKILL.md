---
name: maestro
description:
  maestro CLI for composing and performing agent compositions as concerts. Use when setting maestro up in a project
  (.maestro/config.yaml), performing a composition or a no-spend stub concert, following, killing or resuming a concert,
  reading its exit code or record, or writing a composition or pack.
---

# maestro

maestro builds a composition into a checked plan with `compose`, which spends nothing, then `perform`s it as a concert.
The concert's agents and checks work in lanes, isolated copies of the target repository, never in the user's checkout.
Results leave as a changeset, a set of patches the user applies.

This skill was checked against maestro 0.1.0-rc.1. When `maestro --version` names another release, trust
`maestro <verb> --help` wherever the two differ.

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
- **Pack**: an installed directory of compositions, under `$XDG_DATA_HOME/maestro/packs/` or listed in config under
  `packs`.
- **Workspace**: the nearest directory from the cwd up holding `.maestro/`; its config layers over the user's.
- **Data root**: where the record store and concert files live: `$XDG_DATA_HOME/maestro` (default
  `~/.local/share/maestro`), moved by the `dataRoot` config key.
- **Tour**: a slug grouping related concerts, for listing and pruning them together.

## The loop

1. **Find the workspace.** Look for `.maestro/config.yaml` from the cwd up. None, or a profile runtime, target or check
   missing: read [bootstrap.md](bootstrap.md) and follow it. Done when `maestro compose <c>` reports no `CFG.*` or
   `HOST.*` diagnostic; a runtime set only in a preset needs `--preset <name>` on that compose too.
2. **Pick the composition.** `<pack>.<composition>` of an installed pack, or a file. `maestro rep --json` lists every
   installed composition with its doc, params, config entries and a `perform` line; `maestro rep <pack>.<composition>`
   shows one, such as `classics.panel_review`. Its params are kebab-case flags (`--max-repairs 3`, `--no-strict`). Done
   when every required param has a value from a flag or the config. `compose` also fills a missing required root param
   from the composition's example set; `perform` never does, and refuses with `CFG.required`, so pass the flag or set it
   in config (see [running.md](running.md), section Compose).
3. **Pre-flight.** `maestro compose <c> [flags]`, with the flags perform will get. Done on exit 0. Before a perform on a
   paid harness, give the user the `repo.agent` bound from `maestro compose <c> [flags]` as the spend ceiling.
4. **Perform in its own session.** `perform` holds its terminal until the concert settles, and a signal to its process
   group cancels the concert. Start it detached, its output in a fresh directory outside the checkout; echo the
   directory, since shell state does not carry between tool calls:

   ```sh
   log=$(mktemp -d) && echo "$log"
   setsid -f maestro perform <c> [flags] --tour <slug> --title "<what for>" >"$log/out" 2>"$log/err"
   ```

   Poll for the id, bounded, then read it:

   ```sh
   for _ in $(seq 60); do grep -q '^concert ' "$log/err" && break; sleep 0.5; done; cat "$log/err"
   ```

   Done when `$log/err` holds a `concert <id>` line. A perform that exits before that line printed why in its place.

5. **Follow.** `maestro wait <id> --timeout 90s` in a loop, the timeout shorter than your tool call's own limit, which
   would otherwise cut it off before exit 124: exit 124 means still running, so wait again. Done on any exit but 124. A
   user who wants to see the concert live runs `maestro watch <id>` in their own terminal, where it stays open after
   settle until `q`; piped, it ends at settle.
6. **Read the result.** The exit code (table below), the closing block on stderr (a
   `concert <short id>  <outcome>  <elapsed>` row, then `at <instance>` and `reason <reason>` when not `ok`) and the
   result's outputs on stdout (`<port>  <value>` lines, an artifact as its path). On a `rejected` concert the outputs
   are the root cause's: `logs`, the failing check's log file, and `lane`, a lane ref to the version the concert stopped
   at. Read the `logs` file next, then report the root cause. Done when the user has the outcome, the root cause
   instance and its reason when not `ok`, and the changeset's path.

Read [running.md](running.md) for compose and perform flags, the record, artifacts, changesets and lane refs.

## Exit codes

| Code | Means                                                                  | Next                                                                    |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 0    | Done, or the concert settled `ok`                                      | Report the outputs and the changeset                                    |
| 1    | The concert settled `failed`, or the command could not do what it said | Read the message; for a `failed` concert, fix the root cause and resume |
| 2    | Usage error, or the composition does not compose                       | Read each diagnostic's code and hint; fix, compose again                |
| 3    | The concert settled `rejected`                                         | Report the verdict: the root cause instance and its reason              |
| 124  | `wait --timeout` passed, the concert still running                     | Wait again, or `maestro kill <id>` when the user says to                |

## Outcomes

- `ok`: the concert did what it was built for.
- `rejected`: a verdict, such as a red check or a verdict agent's no. The concert's reason is its root cause's.
- `failed`: a crash, a broken contract (a timeout, a missing declared output, a cancel) or an agent's
  `blocked: <cause>`. Fix the cause, then resume.
- `skipped`: an instance whose guard was false or whose input was not `ok`; it points at a root cause elsewhere.

## Recover

- **Resume**: `maestro perform --resume <id>` after fixing what failed or rejected. `ok` instances whose inputs and code
  are unchanged are reused; the rest perform again, under the config as it stands now.
- **Encore**: `maestro perform --encore <id>` performs a concert's composition again as a new concert, each agent
  continuing its counterpart's session and told what changed; pass a param flag to change one.
- **Kill**: `maestro kill <id>` stops a running concert, which settles `failed` and can be resumed.
- A `perform` process that is interrupted or dies leaves its concert `failed`, and the concert resumes the same way.
- **Prune**: `maestro prune` deletes concerts with their records and lanes. Prune the concerts you started or the user
  names, by id or by `--tour`.

Read [running.md](running.md), section Recover, for resume's refusals and the `--preset` and `-c` it reapplies, how an
encore matches agents, and how prune selects.

## Stub concerts

A stub concert rehearses a composition for free: stub agents change nothing and reply `ok`, while checks run for real,
so a check that depends on an agent's change stays red. A check already green on the untouched target passes, so a build
composition such as `classics.build_then_repair` ends `ok` with an empty changeset, holding only its `base`. A stub
agent writes a placeholder for each output it declares, the smallest value that satisfies the schema keywords it reads
(`required`, `properties`, `items`, `minItems`, `enum`, `const`, `minLength`, `minimum`, `anyOf`, `oneOf`), `"stub"` for
text. A schema beyond those fails the agent, naming the output. So a concert runs past its agents and proves config,
profiles, lanes and checks: `classics.panel_review` ends `ok` with an unapproved verdict, and `classics.v_model` is
always rejected: its checks stay red because nothing was built, and when they are green its final traceability step
rejects it, since the stub review never approves. Use one to try a flow, or whenever the user asks for no spend. It also
shows what each agent is told before any spend: its host stages the instructions and prompt as for a real run, so
`maestro art <id> <instance> staged/instructions.md` and `staged/prompt.md` print them. Set every profile the
composition's seats name to the stub harness in `.maestro/presets/stub.yaml`, and pass `--preset stub` to compose and
perform; a resume reapplies it. `MAESTRO_STUB_DELAY` (a duration such as `2s` or `500ms`) makes each stub agent turn
wait that long, to rehearse a slow run. `MAESTRO_STUB_OUTPUTS=<dir>` scripts what agents deliver, to rehearse a branch
that hangs on it, such as a fix loop: a stub agent takes each declared output from `<dir>/<instance id>/<file>` (the id
as `maestro ls <id>` prints it, such as `loop[0]/review`), else from `<dir>/<node id>/<file>` (the id without `[n]`
indices, serving every round), else the placeholder. A verdict agent's `verdict` file, found the same way, holds `ok` or
`rejected <reason>`; without one it rules `ok`. An `events.jsonl` file found the same way holds the harness events the
agent emits first, one JSON object per line. Files are copied as is and validated like any output. A resume needs the
variable set again; a missing dir fails the agent. `MAESTRO_STUB_ENVIRONMENT` (a JSON object such as
`{"mcp":["github"]}`) replaces parts of what the stub reports loading, to rehearse an environment fault. For the
classics pack's seven profiles:

```yaml
profiles:
  classics/scout: { runtime: !replace { harness: stub, model: none } }
  classics/planner: { runtime: !replace { harness: stub, model: none } }
  classics/builder: { runtime: !replace { harness: stub, model: none } }
  classics/lens: { runtime: !replace { harness: stub, model: none } }
  classics/skeptic: { runtime: !replace { harness: stub, model: none } }
  classics/consolidator: { runtime: !replace { harness: stub, model: none } }
  classics/documenter: { runtime: !replace { harness: stub, model: none } }
```

## The classics pack

maestro's release ships one pack, `classics`:

- `classics.build_then_repair`: builds the request in a fresh lane, repairs while the checks are red, and leaves a
  changeset.
- `classics.panel_review`: reviews a lane version (`--change`) or target commits (`--revs main..feature`) through each
  lens, a skeptic weighing each lens's findings, then consolidates. Lenses run on the `classics/lens` profile's model
  and skeptics on the `classics/skeptic`'s: pick models of different families for the two, since a skeptic of the lens's
  family tends to share its blind spots.
- `classics.v_model`: scouts, plans, builds and repairs, reviews each scouted risk, and traces acceptance to the plan.
- `classics.repair_until_green`: the repair loop the others use; it is not performed alone.

A composition outside the pack builds on its parts through `@maestro/classics`, a package tarball set up as
[packs.md](packs.md) says:

- `panel`: the lens, skeptic and consolidator panel, as a function over a change.
- The seats: `builder`, `lens`, `skeptic`, `consolidator`, `scout`, `planner`, `documenter`.
- The compositions: `repairUntilGreen`, `panelReview`, `buildThenRepair`, `vModel`.
- `maxRepairs`, the repair bound, and `atLeastOne`, the at-least-one integer param.
- Code-node functions: `survivorsOf`, `toMarkdown`, `dossierOf`, `traceOf`, `riskKey`.
- Types: `Findings`, `Verdict`, `Verdicts`.

`repairUntilGreen` takes a `checks` param, the names in `target.checks` its repair agent may run with `check <name>`; it
defaults to none, and its recheck runs every check of the target.

Installed, it is `<packs dir>/classics`, and `maestro rep --json` gives each composition's doc, params and config
entries; its `README.md` there says more. Missing: install it by [bootstrap.md](bootstrap.md), step 3.

## Writing

- A shape the classics pack lacks is a new composition: read [composition.md](composition.md).
- A set of compositions to share or install elsewhere is a pack: read [packs.md](packs.md).

## Ground rules

- The user's checkout stays theirs: maestro never writes it, and applying a changeset waits for the user's yes.
- Secrets live in the environment (`CLAUDE_CODE_OAUTH_TOKEN`, a harness login); params and committed config hold none.
- A pack is code that runs with the user's permissions: install or list under `packs` only packs the user chose.
- Parse `--json` output, which every verb but `cs` takes; the text form is for people.
- `maestro <verb> --help` holds every flag this skill does not name.
