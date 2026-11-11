---
name: good-tests
description: What a good test is, how to mock and the anti-patterns. Use when writing or judging tests.
---

# Good Tests

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.
A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists,
and it survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel
  (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior
  hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`,
  a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can
  never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a
  worked example, the spec.
