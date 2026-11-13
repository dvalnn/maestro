The tests the change adds or touches, and the behaviour it adds or alters.

1. Each new or altered behaviour, and each piece of logic reading does not settle at a glance, is pinned by a test that
   fails when it is removed, judged as a mutation would: name the behaviour and its test, or the line whose removal no
   test catches.
2. Each test asserts through the public interface: a returned value or an observable effect, never a private function, a
   call count or order, or a side channel such as a database row the interface could return.
3. Each expected value comes from an independent source, a known-good literal, a worked example or the spec, never
   recomputed the way the code computes it.
4. A mock stands only at a system boundary (an external API, time, randomness, at times the file system or a database),
   never for the change's own modules or collaborators.
5. Each test's name says what behaviour it pins, not how the code does it.
6. No test duplicates another's coverage or restates the implementation.
7. Logic with edges, such as a limit, an empty input or one past the end, is tested at them.
8. No test pins wording that is no contract, such as an error message or a prompt, unless the text is piped stdout,
   `--json` output or a line something parses.
