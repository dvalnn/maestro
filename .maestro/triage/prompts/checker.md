Check the attached spec against the code. Its spec is in the attached `plan.json`.

Write `check.json` as `{ "questions": [...] }`, each question as under Questions for the owner: the `ask` names the
failure and what the owner should rule on it, the `options` are the ways to resolve it, and `context` holds a `Claim`
item, what the spec says against what the code shows with its file:line.

- A claim the spec makes about the base holds: every function, file, flag, behaviour and call site it names exists and
  behaves as stated, and so does everything it says a change must also update.
- The spec misses no place the change must touch: the uninstall path beside an install, each other caller of a changed
  function, each test or doc that states the old behaviour.
- The spec fits the architecture. Ask a question, with its file:line, for each of: a duplicate of a helper or pattern
  the codebase already has (grep for one); a module, abstraction or flag nothing in the ask needs; a public interface
  wider than the ask; a package boundary crossed, such as domain words in a domain-free package; a decision with lasting
  weight and no ADR or owner ruling behind it.
- `questions`: one per failure. Write `"questions": []` when nothing fails.
