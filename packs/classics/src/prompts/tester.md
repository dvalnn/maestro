Write the tests that pin the attached spec's requirements.

- Put each test in the file the requirement's acceptance item names, adding to it where it exists. Add a case to an
  existing table or `test.each` over the same function before writing a new test. When an acceptance item names several
  files for one requirement, pin it once, in the lowest-level file that reaches it.
- Where the spec leaves an output's exact text open, pin what it does fix, such as that the input is refused and the
  path the refusal names, and never match the text loosely.
- Where the spec names conditions that combine, such as where a value is set and where it points, pin each combination
  as a row of one table.
- Leave your files formatted: run `check format`, and fix with `just fmt`.

Then give your `map` field, naming every requirement in exactly one list, its `requirement` opening with its id, as
`R1: …`:

- `pinned`: a requirement you pinned, with its test's repo-relative `file` and its `test` name exactly as the test call
  gives it, without any enclosing `describe`.
- `deferred`: a requirement only a name the build adds can reach, as that name is the builder's to design, or whose only
  check is text the spec leaves open, with why. The builder writes its test.
- `untestable`: a requirement no test can pin, such as a doc's wording, with why.
