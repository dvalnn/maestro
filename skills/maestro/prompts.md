# Prompts

How an agent's prompt is layered, and how a composition or pack writes its task layer.

## Layers

An agent reads five layers, in this order, each with one home; no layer restates another's text:

1. **Frame**, from the host: working copy, checks, output schema. Never restated.
2. **Profile**, `profiles/<name>/instructions.md`: who the agent is and how it works, true in every call.
3. **Area**, a preset's profile `attachments`: what is true of one part of the target.
4. **Task**, one Markdown file per call, and its fragments: what this call asks, its inputs by name, its outputs, its
   bar. The host adds the call's `relay` sections, then a tree of its attachments with type and size.
5. **Attachments**, written by code nodes: the run's data, never instructions.

`maestro art show <id> <instance> staged/prompt.md` and `staged/instructions.md` show what an agent was told.

## Task files

- One `.md` file per call, named for its `label`: `.maestro/<id>/prompts/` beside a bare file, `src/prompts/` in a pack.
- Import it as text: `import task from "./prompts/build.md" with { type: "text" }`. The attribute is mandatory, or Bun
  imports Markdown as HTML. For `tsc`, declare the type once:
  `declare module "*.md" { const text: string; export default text; }`.
- Keep one `TASKS` table near the composition file's top, each call's task file then the fragments it rules by, so one
  read shows everything a seat is told.
- A text shared by several tasks is a `_`-prefixed file joined after each as a paragraph. A composition imports prompts
  only from its own prompts directory or the shared `.maestro/prompts/`; a fragment a second composition needs moves
  there.
- Build-time one-line values fill `{name}` placeholders: `fill` in `@maestro/classics` does it, throwing on an unmatched
  name or value. Text built from Refs comes from a code node.
- What an agent reads at perform time reaches it as an attachment, mounted at `/in/<name>`, a file with its source's
  extension added, with its `hint`. A hint says when to read the file and for what, not what it is and not what the file
  says.

## Form by scope

Each text takes the form of its scope:

| Scope                            | Form                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| True of the agent in every call  | the profile's `instructions.md`, direct instructions               |
| True of one area or run          | a preset's profile `attachments`, a file of facts                  |
| One call                         | the task file, direct instructions                                 |
| Several tasks of one composition | a `_` fragment in that composition's prompts directory             |
| Tasks of several compositions    | a `_` fragment in `.maestro/prompts/`                              |
| The run's data                   | an attachment a code node writes, an artifact the task works on    |
| A value known at build time      | a `{name}` placeholder `fill` sets, or a relay for a perform value |

## Attachments

Every attachment is must-read: the host lists them under a lead that tells the agent to read each one. So an attachment
carries only the artifact the task works on, such as a spec or a diff. Guidance, a checklist, a style guide or a skill,
never travels as an attachment; it goes in the profile or the task, where the agent acts on it.

## Reply schemas

The frame shows each reply schema, so a task never copies one. A task gives a fenced `json` example the schema accepts,
its field rules as prose under it; keep the example valid when the schema changes, and test that it parses.

## Review seats

A review seat is three parts, each in its layer:

- **Identity**, in its profile: who the reviewer is and how it works.
- **One job**, at the top of its task: the one concern it reviews, and what belongs to other seats.
- **A checklist**, in its task: numbered items it rules on one by one, each met or broken with its `file:line`. A broken
  item is a finding that cites its checklist and number.
