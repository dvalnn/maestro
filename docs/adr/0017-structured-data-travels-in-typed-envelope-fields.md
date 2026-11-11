---
status: accepted
---

# Structured data travels in typed envelope fields

A seat's structured result, such as the tester's map or a reviewer's findings, was a JSON file the agent wrote in its
outbox. The host read it after the reply, and a file that was missing or off its schema drew the correction turns. The
data was an artifact in the graph, though no later seat could read it as a value, and the agent had to write a file and
also report it.

The rule is:

- **A seat call declares typed fields of the agent's envelope** with `reply: { name: type }`, each type a JSON schema
  the SDK takes from an SDK type. The field sits beside `report` in the envelope, and its value arrives as the output of
  its name.
- **The host validates the fields with the envelope**, and a field missing or off its schema gets the envelope's
  correction turns, in the same session, then fails the node.
- **A field is required unless the agent is blocked**, a rejection included. Blocked agents end `failed` with no outputs
  (ADR 0012). A rejection missing a field is corrected and then fails, where a rejection missing a declared file ends
  `rejected` with no outputs, because a rejection's fields are what the next seat acts on.
- **The reply template lists each field with its schema**, so the contract the agent reads and the check the host runs
  are one declaration.
- **A field's name is none of the envelope's keys or an agent's own ports**, nor an output's: it would share a port.
- **The practice is guidance through API design, not mechanism.** Structured data is a typed field, Markdown is an
  outbox file, and a large or browsed file of any format is an outbox file. Nothing refuses another choice. The table is
  in the host-repo README ([Handing work on](../../packages/host-repo/README.md#handing-work-on)).

## Considered options

- **Files only, as before.** The agent writes data it already reports, and no composition can read the value. Rejected.
- **A file's content as the value.** A reader node reads it, visible in the graph (ADR 0007). That is the right tool for
  a large file, and costs a node and a file for a value the reply can carry. Kept for large files only.
- **A mechanism that refuses a JSON outbox file.** Some data is large, or a file a person browses. Rejected: the
  practice guides, and review holds the line (`CODING_STANDARDS.md`).

## Consequences

- No IR change: the fields ride the agent node's config, and each is a value port.
- A resume key holds the reply template, so a changed field declaration starts the agent afresh.
- A field's value is JSON, so an artifact type is no field type.
