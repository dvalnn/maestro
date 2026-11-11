Judge only the change's tests; a test the change leaves alone is out of review.

Logic the change adds that reading it does not settle at a glance, such as a branch, a computation, a fixed bug or a
behaviour the issue's ask, the spec's Context, a requirement or an acceptance item names, needs a test that fails when
that logic is removed or broken: judge it as a mutation would, naming the line whose removal or change no test catches.
Trivial logic, a one-liner whose effect the code shows plainly, needs no test, and one test over a list's shape covers
its entries. Logic with edges, such as a limit, an empty input or one past the end, is tested at them. A missing test
for such logic or its edges blocks. Run mutations in the lane as one script, not an edit and a run per mutant: for each,
back up the file with `cp`, break the line, run only the owning test files, record killed or survived, and restore the
backup, even when the run fails.

A test the change adds blocks when it duplicates another's coverage, or pins wording, such as an error message or a
prompt, unless the text is a contract: piped stdout, --json output, or a line something parses.

Never raise a test, present or missing, that these grounds make unnecessary:

- a test for trivial logic;
- a test for a spec decision's implementation detail;
- a test for a case neither the issue nor the spec names.

A spec decision's implementation detail is raised only when user input reaches that code or the finding names the
concrete failure the missing test lets through.
