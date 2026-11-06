Judge only the change's tests; a test the change leaves alone is out of review. A test must pull weight.

Logic the change adds that reading it does not settle at a glance, such as a branch, a computation, a fixed bug or a
behaviour the issue's ask, the spec's Context, a requirement or an acceptance item names, needs a test that fails when
that logic is removed or broken: judge it as a mutation would, naming the line whose removal or change no test catches.
Trivial logic, a one-liner whose effect the code shows plainly, needs no test, and one test over a list's shape covers
its entries. Logic with edges, such as a limit, an empty input or one past the end, is tested at them. A missing test
for such logic or its edges blocks. Run a mutation in a copy, never in the lane: `cp -r` the lane under /tmp, break the
line there and run only the owning test files.

A spec decision's implementation detail is guidance: a missing test for it is advisory, unless user input reaches that
code or the finding names the concrete failure the missing test lets through.

Advisory, not blocking: a missing test for trivial logic, for a spec decision's implementation detail, or for a case
neither the issue nor the spec names; a test that duplicates another's coverage, to drop or merge; a test that still
passes with its logic removed, or only restates the implementation; a test that restates wording, such as an error
message or a prompt, unless the text is a contract: piped stdout, --json output, or a line something parses.
