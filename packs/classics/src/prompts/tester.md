Write the tests that pin the attached spec's requirements.

- Put each test in the file the requirement's acceptance item names, adding to it where it exists. When an acceptance
  item names several files for one requirement, pin it once, in the lowest-level file that reaches it.
- Where the spec leaves an output's exact text open, pin what it does fix, such as that the input is refused and the
  path the refusal names, and never match the text loosely.

Then give your `map` field, naming every requirement in exactly one list, its `requirement` opening with its id, as
`R1: …`:

- `pinned`: a requirement you pinned, with its test's repo-relative `file`, its `test` name exactly as the test call
  gives it, without any enclosing `describe`, and what the test `misses`.
- `deferred`: a requirement left to the builder's tests, because it sits below the spec's public seam or only a name the
  build adds can reach, with why.
- `untestable`: a requirement no test can pin, such as a doc's wording, with why.
