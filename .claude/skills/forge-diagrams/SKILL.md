---
name: forge-diagrams
description:
  Draw Mermaid diagrams for Markdown the forge renders - docs, issues, PR bodies - so they read in its dark and light
  themes, then render them locally to check before pushing. Use when adding or changing a Mermaid block in any doc,
  issue or PR.
---

# Forge diagrams

The forge renders fenced `mermaid` blocks in an iframe, in the viewer's theme, dark by default. A diagram is checked by
its look, not just by parsing.

## Rules

1. **Labels are tags.** A node is a name (`in-review`), an edge one to three words (`[tick] PR`, `low, medium`). Detail
   goes in a numbered list under the diagram, pointed at with a superscript in the label (`red ¹`). Prose belongs in the
   Markdown around it, as tables do with footnotes.
2. **One idea per diagram.** Past a dozen nodes or once edges cross, split it: an overview and zooms, or forward moves
   and moves back. A flowchart lays out cleaner than a `stateDiagram-v2` with a composite state.
3. **Actors in brackets.** An edge that names who acts reads `[actor] event`.
4. **No hard fills.** The theme sets fill and text colour; a light `fill:` leaves white text on pale yellow in dark
   mode. Highlight with a stroke from the palette below, never a fill.
5. **Parse-safe labels.** Quote any label with spaces or punctuation. No `;`, no second `:`, no `/` outside quotes, no
   `<n>`: write `factory/i-n`.
6. **Say what styling means.** Colour, bold and dotted each carry a meaning, stated in the line above the diagram, and
   never the only carrier of it: the label or a note says it too.

## Palette

Stroke colours that read on the forge's dark and light themes. Use only the roles a diagram needs.

| Role  | Meaning                    | `classDef`                                       |
| ----- | -------------------------- | ------------------------------------------------ |
| owner | waits on, or is, the human | `classDef owner stroke:#d4a72c,stroke-width:3px` |
| agent | a concert or agent acts    | `classDef agent stroke:#4c9be8,stroke-width:3px` |
| fault | a failure or halt          | `classDef fault stroke:#e5534b,stroke-width:3px` |
| done  | a terminal success         | `classDef done stroke:#57ab5a,stroke-width:3px`  |

## Shapes and edges

| Form      | Meaning                               |
| --------- | ------------------------------------- |
| `["x"]`   | a state or a step                     |
| `(["x"])` | a start, an exit or a terminal state  |
| `{"x?"}`  | a decision; its edges are the answers |
| `[["x"]]` | a step a zoom diagram details         |
| `-->`     | the normal move                       |
| `==>`     | the owner's move                      |
| `-.->`    | an exception or a side effect         |

## Check

```
.claude/skills/forge-diagrams/scripts/render.sh <file.md> <scratch-dir>
```

It renders every block in both themes and prints the PNG paths. Read each PNG: a block that fails to render, a label
that overlaps an edge, or a tangle is fixed before pushing. After pushing, open the file on the forge and look again.
