# Issue tracker: Forgejo

For agents and the owner: where issues live, their shape, and how a slice reports. Issues live on the forge,
[`tiago/maestro`](https://git.amorimcasa.org/tiago/maestro/issues), driven by `fj` as `forge-bot` (`FJ_USE_BOT=1`, set
in `.claude/settings.json`). Never `gh` or `glab`; `fj --help` lists the commands. What `fj` cannot do goes through the
`forgejo` skill's `forge.py api`.

`.scratch/` is untracked working space for drafts and the session handoff; nothing in it is an issue.

## The issue

- **Body.** The ask: a slice brief or a backlog item. Once work starts, the ask stops changing; an agreed scope change
  is a comment saying what changed and who agreed it.
- **Citations.** An issue or brief cites only ids the repo or tracker holds (requirement IDs, ADRs, issue numbers),
  never a call tag from a chat session (`D26`, `E118`).
- **Labels.** One `kind/` and one `state/` label (`triage-labels.md`). Both scopes are exclusive, so adding a `state/`
  label replaces the old one.
- **Tour manager.** The ask sits above a `<!-- maestro-tm -->` marker and stops changing; below it the tour manager
  keeps one line linking its spec comment. The owner answers its questions in a reply mentioning `@forge-bot`, the login
  it acts as; any other comment is not read. Surfaces and rules: `factory.md`.
- **Milestone.** The release that ships it, named by its version (`v0.1.0`). Only the next release or two have one; an
  issue with none is icebox, an indefinite deferral. Planned but not ready is a milestone beside `state/needs-triage`.
  Pre-releases (`-rc.<n>`) have no milestone: they are cuts toward the one that does.
- **Closing.** A commit on `main` whose description says `Closes #N` closes it when the owner pushes, or when a tour
  manager PR carrying it merges (auto-merge included). A duplicate is closed at once with `state/duplicate` and a
  back-reference. An epic closes when its last child does. Nothing else closes an issue.

## Commands

`fj` has a verb for issues, labels, comments and search. Two things its help cannot say:

- `fj issue edit <n> body` opens an editor; prefer a comment once work has started.
- `fj issue search --labels` filters by label, and `--state all` includes closed issues.

The rest goes through `forge.py`:

```
forge.py api GET /milestones                         # ids for the releases
forge.py api PATCH /issues/<n> '{"milestone": <id>}'
forge.py api POST /issues/<n>/dependencies '{"owner": "tiago", "repo": "maestro", "index": <blocker>}'
```

`forge.py` is `.claude/skills/forgejo/scripts/forge.py`, agent tooling; the tour manager calls the REST API itself, in
`scripts/factory/forge.ts`.

## When a skill says "publish to the issue tracker"

Create the issue, then set its labels and, if a release ships it, its milestone.

## When a skill says "fetch the relevant ticket"

View the issue and its comments. The user normally passes the number.

## A slice brief and its report

The brief is the issue body, in the template of `implementation-loop.md`. Where a picture says it faster, add a
**Summary**: the smallest view of the target shape, such as a `diff` of the call tree, file tree or API.

The report is the closing comment, in this order:

1. **Summary**, only where what landed differs from the brief's.
2. **Evidence**: the acceptance table, each item and the test that pins it, and the `just check` result.
3. **Door**: one-way (a contract: IR field, public CLI flag or exit code, config key, an id or path format users type,
   pack manifest) or two-way, then the **blast radius** in a few words.
4. **Derived, not ruled**, **Review triage** and **Loop**: the tables `implementation-loop.md` requires.

No file inventory and no walk through the diff; the diff is one click away.

## Wayfinding operations

- **Map.** One issue labelled `wayfinder:map`, with its own milestone.
- **Ticket.** A child of the map: a `Map: #N` line opens its body, it sits on the map's milestone, and it carries a
  `wayfinder:<type>` label beside its `kind/` and `state/` labels.
- **Claim.** `forge.py api PATCH /issues/<n> '{"assignees": ["tiago"]}'`.
- **Blocking.** Native dependencies, the `POST /issues/<n>/dependencies` line above.
- **Frontier.** `fj issue search --labels wayfinder:<type>`, filtered to open, unassigned tickets whose blockers are
  closed (`forge.py api GET /issues/<n>/dependencies`).
