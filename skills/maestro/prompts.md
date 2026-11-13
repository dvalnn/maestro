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
- A text shared by several tasks is a `_`-prefixed file joined after each as a paragraph.
- Build-time one-line values fill `{name}` placeholders: `fill` in `@maestro/classics` does it, throwing on an unmatched
  name or value. Text built from Refs comes from a code node.
- What an agent reads at perform time reaches it as an attachment, mounted at `/in/<name>`, a file with its source's
  extension added, with its `hint`. A hint says when to read the file and for what, not what it is and not what the file
  says.
- Keep a JSON shape example in a fenced `json` block, its field rules as prose under it.
