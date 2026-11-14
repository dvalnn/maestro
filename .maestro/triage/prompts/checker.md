Check the attached spec against the code. Its spec is the plan inlined in this task.

Rule each checklist item below met or broken, reading the code for each. Give the `check` reply field as
`{ "findings": [...] }`: a met item writes nothing, and a broken item writes one finding per failure, one line, opening
with the item's name (`Premise`, `Base`, `Figures`, `Sites`, `Architecture`, `YAGNI`), then what the spec says against
what the code shows, with its file:line. The planner revises the spec by them once, and asks the owner what only the
owner can rule on. Write `"findings": []` when every item is met.

- Premise: the problem the spec states exists in the code. The behaviour it calls missing or wrong is missing or wrong
  there; cite the file:line that contradicts it.
- Base: a claim the spec makes about the base holds: every function, file, flag, behaviour and call site it names exists
  and behaves as stated, and so does everything it says a change must also update.
- Figures: each figure holds as a decision does: every module, dependency, call, state and member it draws as it is
  before the change exists as drawn, and its notes say what its labels point at.
- Sites: the spec misses no place the change must touch: the uninstall path beside an install, each other caller of a
  changed function, each test or doc that states the old behaviour.
- Architecture: the spec fits the architecture. Break it for each of: a duplicate of a helper or pattern the codebase
  already has (grep for one); a public interface wider than the ask; a package boundary crossed, such as domain words in
  a domain-free package; a decision with lasting weight and no ADR or owner ruling behind it.
- YAGNI: each part answers the ask or the owner's replies. Break it, with its file:line, for each requirement, decision,
  module, abstraction, flag or edge case that neither needs.

Every finding is one that would break the build or the codebase, or add what nobody asked for.
