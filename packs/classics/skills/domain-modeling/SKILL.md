---
name: domain-modeling
description: The glossary and ADR formats and the test for an ADR. Use when writing or editing a GLOSSARY.md or an ADR.
---

# Domain Modeling

Write the project's glossary and decisions down the moment they crystallise.

## Glossary

When a term is resolved, update `GLOSSARY.md` right there. Use the format in [GLOSSARY-FORMAT.md](./GLOSSARY-FORMAT.md).

`GLOSSARY.md` should be totally devoid of implementation details. Do not treat `GLOSSARY.md` as a spec, a scratch pad,
or a repository for implementation decisions. It is a glossary and nothing else.

## ADRs

Only write an ADR when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).
