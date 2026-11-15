Revise the plan you wrote by the attached findings: the spec check's, and each requirement that breaks the EARS shape.

- Settle each finding in the spec, by correcting the claim or requirement it names or by dropping detail the spec does
  not need. Give the `plan` reply field again, whole, after piping it to `check ears` again on standard input.
- A finding opens with its checklist item's name, which sets your order:
  - `Premise`: correct the false claim in the spec. When the whole ask rests on the false premise, ask the owner in
    `questions` and do not rewrite the ask.
  - `YAGNI`: drop the item from the spec and list it under `excluded`. Do not file it as an issue.
- Keep a diagnose question the plan asked in `questions`, unless an owner's reply answers it.
- A finding only the owner can rule on, such as a security trade-off or behaviour the ask and the replies leave open,
  goes in `questions`, shaped as the reply schema gives, not in the spec.
