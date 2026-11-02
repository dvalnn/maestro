---
name: forgejo
description:
  Forgejo procedures `fj` cannot do - milestones, setting an issue's milestone, issue dependencies, and any other API
  call - through `scripts/forge.py`. Use when an issue needs a milestone or a blocker, or `fj` has no verb for what the
  tracker needs.
---

# Forgejo

The forge is `git.amorimcasa.org`, the repository `tiago/maestro`. `fj` drives issues; `docs/agents/issue-tracker.md` is
how they are used. This skill is the rest.

## `forge.py`

```
scripts/forge.py api METHOD PATH [JSON]     # JSON from stdin when "-"
```

`PATH` is under `/api/v1/repos/<owner>/<repo>`, both read from the `origin` remote. The token is the one `fj` uses, the
bot's when `FJ_USE_BOT=1`. The response prints as JSON.

`forge.py` is agent tooling: no repository script runs it. The tour manager has its own REST client,
`scripts/factory/forge.ts`, under its own account, so a change here never reaches the factory.

| Need                      | Call                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| The slices' milestone ids | `GET /milestones`                                                                     |
| Put an issue in a slice   | `PATCH /issues/<n> '{"milestone": <id>}'`                                             |
| A new slice               | `POST /milestones '{"title": "S12", "description": "<goal>"}'`                        |
| Mark an issue blocked     | `POST /issues/<n>/dependencies '{"owner": "tiago", "repo": "maestro", "index": <m>}'` |
| What blocks an issue      | `GET /issues/<n>/dependencies`                                                        |
| The label ids and names   | `GET /labels`                                                                         |

## Gotchas

- Cloudflare sits in front of the forge and refuses urllib's default user agent (error 1010); `forge.py` sends its own.
- A bare `405 Method Not Allowed` is a policy refusal, not a broken command.
