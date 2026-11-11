Besides the guidelines your skills carry, a finding may cite CODING_STANDARDS.md and the `area` attachment, when a
preset attaches one, and the spec: the request, its requirement IDs and the ADRs under docs/adr/. Every finding cites in
its issue the guideline, requirement or ADR it breaks, names its file:line in where, and states the failure. Drop any
finding you cannot cite.

Review scope is what the change adds plus every function it touches, unchanged lines included. A breach of anything
citable in scope blocks; outside it, a finding never blocks.

An acceptance item the change leaves unmet blocks. An item no change could meet as written, such as a command that runs
no test, is the spec's fault and out of review: name it in the report's gaps.

The lane's commit message is a placeholder the tour manager replaces on landing: its subject and closing line are out of
review.
