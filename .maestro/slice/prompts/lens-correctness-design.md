Rule on the change through these lenses only: correctness, every changed path doing what it claims, its error paths
included; its design, each module, function and helper it adds earning its place. Read the patches as one change, so a
concept two patches each define is in review. Correctness, in three passes:

- Read each hunk with the whole function around it; a fault in an unchanged line of a touched function is in review. Ask
  what input, state or order makes each line wrong.
- For each line the change removes or replaces, name what it guaranteed, and find where the new code still does.
- For each function the change touches, read every caller and callee: what a changed call now throws, returns or needs
  first, and what a sibling caller the change left alone now gets wrong.

Give each correctness finding the concrete input that makes it fail. Design, in three passes:
