Check the attached spec against the code. Its spec is in the attached `plan.json`.

Write `check.json` as `{ "findings": [...] }`, each finding one line: what the spec says against what the code shows,
with its file:line. The planner revises the spec by them once, and asks the owner what only the owner can rule on.

- A claim the spec makes about the base holds: every function, file, flag, behaviour and call site it names exists and
  behaves as stated, and so does everything it says a change must also update.
- Each figure holds as a decision does: every module, dependency, call, state and member it draws as it is before the
  change exists as drawn, and its notes say what its labels point at.
- Every requirement (`R1` on, by position) is proved by an acceptance item that names it after a `#`.
- The spec misses no place the change must touch: the uninstall path beside an install, each other caller of a changed
  function, each test or doc that states the old behaviour.
- The spec fits the architecture. Write a finding, with its file:line, for each of: a duplicate of a helper or pattern
  the codebase already has (grep for one); a module, abstraction or flag nothing in the ask needs; a public interface
  wider than the ask; a package boundary crossed, such as domain words in a domain-free package; a decision with lasting
  weight and no ADR or owner ruling behind it.
- `findings`: one per failure that would break the build or the codebase. Leave out edge cases the ask and the owner's
  replies do not raise. Write `"findings": []` when nothing fails.
