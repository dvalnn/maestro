Check the attached spec against the code. Its spec is in the attached `plan.json`.

Write `check.json` as `{ "findings": [...] }`, each finding one line: what the spec says against what the code shows,
with its file:line. The findings go into the spec for the builder and the PR review; nobody is asked to rule on them.

- A claim the spec makes about the base holds: every function, file, flag, behaviour and call site it names exists and
  behaves as stated, and so does everything it says a change must also update.
- The spec misses no place the change must touch: the uninstall path beside an install, each other caller of a changed
  function, each test or doc that states the old behaviour.
- The spec fits the architecture. Write a finding, with its file:line, for each of: a duplicate of a helper or pattern
  the codebase already has (grep for one); a module, abstraction or flag nothing in the ask needs; a public interface
  wider than the ask; a package boundary crossed, such as domain words in a domain-free package; a decision with lasting
  weight and no ADR or owner ruling behind it.
- `findings`: one per failure that would break the build or the codebase. Leave out edge cases the ask and the owner's
  replies do not raise. Write `"findings": []` when nothing fails.
