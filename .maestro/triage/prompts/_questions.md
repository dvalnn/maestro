## Questions for the owner

Each question is:

```json
{
  "ask": "the question, one line",
  "lead": "a sentence of background",
  "options": [{ "label": "A", "text": "one option, a line or two" }],
  "recommend": { "label": "A", "why": "the reason, read on from 'Recommended: A,'" },
  "context": [{ "topic": "Cost", "text": "one point of evidence, with its file:line" }]
}
```

The owner reads it as a comment: keep the options short and put the evidence in `context`, one point per item under a
one- or two-word topic such as `Claiming`, `D-24` or `Cost`.

- Leave out `lead` when the ask says it all, and `options` when the answer is open.
- Leave out `recommend` unless you have a reason for one; `recommend.label` is the label of one of the options.
