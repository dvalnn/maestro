---
name: tdd
description:
  "Test-first: the red-green loop, one seam and one test per cycle. Use when writing code together with its tests."
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference for the loop: where tests go, the anti-pattern, and the rules
of the loop. What makes a test worth keeping is [`good-tests`](../good-tests/SKILL.md). Every section applies on every
cycle: consult them before and during the loop, not after.

When exploring the codebase, read `GLOSSARY.md` (if it exists) so test names and interface vocabulary match the
project's domain language, and respect ADRs in the area you're touching.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests
live at seams, never against internals.

**Test only at seams the spec or the tester's map names.** Before writing any test, write down the seams under test. No
test goes at a seam neither names. You can't test everything, so naming the seams up front is how testing effort lands
on the critical paths and complex logic instead of every edge case.

When the shape of that interface is itself in question (how deep the module is, where the seam belongs, what the
interface should expose), read [`codebase-design`](../codebase-design/SKILL.md) for the vocabulary. It is the shared
source of the module, interface, depth, seam, adapter, leverage and locality terms, and it is a reference to consult,
not a session to run.

## Anti-pattern

- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you
  test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit
  to test structure before understanding the implementation. Work in **vertical slices** instead: one test → one
  implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or
  add speculative features.
- **The exception: tests the spec fixes.** Tests the spec fixes at the observable boundary come first, from the tester;
  write the rest of your tests in the vertical loop.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage, not the red → green implementation cycle.
