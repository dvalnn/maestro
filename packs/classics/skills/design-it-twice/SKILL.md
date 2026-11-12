---
name: design-it-twice
description:
  "Design it twice: sketch two rival interfaces and compare them. Use when a module's interface is not obvious to
  choose."
---

# Design It Twice

When the interface of a chosen deepening candidate is not obvious, sketch two rival shapes yourself, with no sub-agents.
Based on "Design It Twice" (Ousterhout): your first idea is unlikely to be the best.

Uses the vocabulary in [`codebase-design`](../codebase-design/SKILL.md): **module**, **interface**, **seam**,
**adapter**, **leverage**.

## Process

### 1. Frame the problem space

Before sketching, write out the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see
  [`codebase-deepening`](../codebase-deepening/SKILL.md))
- A rough illustrative code sketch to ground the constraints, not a proposal, just a way to make the constraints
  concrete

### 2. Sketch two shapes

Sketch two interfaces for the deepened module. Each must be **radically different**.

Give each sketch a different design constraint, two of:

- Constraint 1: "Minimize the interface: aim for 1–3 entry points max. Maximise leverage per entry point."
- Constraint 2: "Maximise flexibility: support many use cases and extension."
- Constraint 3: "Optimise for the most common caller: make the default case trivial."
- Constraint 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

Use both [`codebase-design`](../codebase-design/SKILL.md) vocabulary and GLOSSARY.md vocabulary so each sketch names
things consistently with the architecture language and the project's domain language.

Each sketch gives:

1. Interface (types, methods, params, plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [`codebase-deepening`](../codebase-deepening/SKILL.md))
5. Trade-offs: where leverage is high, where it's thin

### 3. Present and compare

Compare the designs in prose. Contrast by **depth** (leverage at the interface), **locality** (where change
concentrates), and **seam placement**.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different
designs would combine well, propose a hybrid. Be opinionated: give a strong read, not a menu.
