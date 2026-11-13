# Tests

A test pins one behaviour at a **seam**: the public boundary where a caller observes behaviour without reaching inside,
such as a function's interface, a command's output and exit code, or a module's exports. A good test reads as a line of
the spec ("a refused input names its path") and survives any refactor that keeps the behaviour.

## Seams

- Write down the seams under test before the first test: the ones the spec or the tester's `map` names. Each test sits
  at one of them, so the effort lands on their critical paths and complex logic rather than on every edge case.
- Drive the behaviour through the seam and observe it through the same seam: create a user, then read it back through
  the interface, rather than querying the store behind it.

## Expected values

Every expected value comes from a source independent of the code: the spec, a worked example, a known-good literal. An
assertion that recomputes the value the way the code does is **tautological**: it passes by construction and can never
disagree with the code.

```ts
expect(add(a, b)).toBe(a + b); // tautological: agrees with any add
expect(add(2, 3)).toBe(5); // pinned by a worked literal
```

## Mocks

Mock only at **system boundaries**: external APIs, time and randomness, and a file system or database where a real or
temporary one is impractical. Everything the project owns runs for real in the test.

## Coupling

A test **coupled** to the implementation breaks on a refactor that keeps the behaviour. Its tells:

- it mocks an internal collaborator, or asserts call counts and order;
- it calls a private function;
- its name says how ("calls paymentService.process") rather than what ("confirms a valid cart").

```ts
// coupled: pins a call, not a behaviour
test("checkout calls paymentService.process", async () => {
  await checkout(cart, card);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});

// behaviour through the seam
test("checkout confirms a valid cart", async () => {
  const result = await checkout(cartWith(product), card);
  expect(result.status).toBe("confirmed");
});
```

## Names

Name each test for the behaviour it pins, in the project's domain language as its glossary gives it.
