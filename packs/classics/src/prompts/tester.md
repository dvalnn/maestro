Write the tests that pin the attached spec's requirements.

- Put each test in the file that owns the behaviour, by the profile's public-seam rule, adding to it where it exists.
- Where the spec leaves an output's exact text open, pin what it does fix, such as that the input is refused and the
  path the refusal names, and never match the text loosely.

Then give your `map` field, naming every requirement in exactly one list, its `requirement` opening with its id, as
`R1: …`:

- `pinned`: a requirement you pinned, with its test's repo-relative `file`, its `test` name exactly as the test call
  gives it, without any enclosing `describe`, and what the test `misses`.
- `deferred`: a requirement left to the builder's tests, because it sits below the spec's public seam or only a name the
  build adds can reach, with why.
- `untestable`: a requirement no test can pin, such as a doc's wording, or none should, with why. None should when the
  change only touches test support or code that does not ship, or the only pin restates the implementation.

Adding no test is a valid outcome. Never test test infrastructure, nor write a test that fails on any other correct
implementation.
