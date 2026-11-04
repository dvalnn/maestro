# Stub concerts

A stub concert rehearses a composition with no spend: it proves config, profiles, lanes and checks before any agent
runs. Use one to try a flow, or whenever the user asks for no spend.

## Setup

Stub every seat with a `"*"` profile, which covers every profile the preset does not name, in
`.maestro/presets/stub.yaml`:

```yaml
profiles:
  "*": { runtime: !replace { harness: stub } }
```

Pass `--preset stub` to compose and perform; a resume reapplies it.

## What it does

- Stub agents change nothing and reply `ok`; checks run for real. A check needing an agent's change stays red; one
  already green on the target passes, so `classics.build_then_repair` ends `ok` with an empty changeset.
- A stub agent writes a placeholder for each declared output: the smallest value meeting the schema keywords it reads
  (`required`, `properties`, `items`, `minItems`, `enum`, `const`, `minLength`, `minimum`, `anyOf`, `oneOf`), `"stub"`
  for text. A schema beyond those fails the agent, naming the output. So `classics.panel_review` ends `ok` with an
  unapproved verdict.
- Each agent's instructions and prompt are staged as for a real run: `maestro art show <id> <instance> staged/prompt.md`
  and `staged/instructions.md` show what it is told.

## Scripting a branch

Environment variables rehearse a branch a placeholder never takes. A resume needs them set again.

- `MAESTRO_STUB_OUTPUTS=<dir>` scripts what agents deliver, such as a fix loop's rounds. A stub agent takes each output
  from `<dir>/<instance id>/<file>` (as `maestro ls <id>` prints it, such as `loop[0]/review`), else
  `<dir>/<node id>/<file>` (no `[n]` indices, serving every round), else the placeholder. A verdict agent's `verdict`
  file, found the same way, holds `ok` or `rejected <reason>`, `ok` when absent. An `events.jsonl` there holds harness
  events the agent emits first, one JSON object per line. Files are validated like any output; a missing dir fails the
  agent.
- `MAESTRO_STUB_DELAY` (a duration such as `2s`) makes each stub turn wait that long, to rehearse a slow run.
- `MAESTRO_STUB_ENVIRONMENT` (a JSON object such as `{"mcp":["github"]}`) replaces parts of what the stub reports
  loading, to rehearse an environment fault.
