---
status: accepted
---

# A code node may write outside the concert, and the host never does

The release composition publishes after its approval: it pushes `main`, creates the forge release and closes the
milestone. HOST-03 says a concert leaves the target untouched, and DIST-04 says maestro uses no network beyond harness
and model traffic. Read as written, both forbid a publish node. A code node can already do it: it runs in maestro's
process with the user's permissions, and nothing checks what it reaches.

The rule is:

- **HOST-03 binds the host.** The repo host writes only its lanes. No host node kind writes the target's checkout, refs
  or commits, and a changeset stays the one way a lane's work leaves.
- **DIST-04 binds maestro.** The engine, the hosts and the CLI use no network beyond harness and model traffic and
  explicit installs.
- **A code node is the author's code.** It may write outside the concert and reach the network. The composition's author
  answers for it, as for any code the operator chooses to run.
- **A node that writes outside the concert sits behind an approval.** The operator rules before the effect, on inputs
  that show what will be published.
- **Such a node checks for its effect before it acts.** A resume runs the node again. It leaves a tag, a release or a
  closed milestone that exists as it is.
- **The release composition never writes the operator's checkout.** It applies the bump in a clone under its scratch
  directory and pushes `main` from there. The operator fetches afterwards.

## Considered options

- **Write the operator's checkout.** The node applies the bump where `maestro perform` ran, then pushes. Rejected: it
  fails on a dirty tree, and a detached concert would edit files under the operator.
- **Publish outside the concert.** The concert ends at the approval and a skill's step list pushes and publishes.
  Rejected: the approval would guard nothing in the graph, which is what ADR 0021 set out to end.
- **A publish node kind in the repo host.** Rejected: pushing a release is one project's procedure, not a coding-agent
  concern. It would also make HOST-03 false for the host itself.
- **Sandbox code nodes.** Deferred: no composition from an untrusted author runs yet, and a sandbox is a larger design.

## Consequences

- A composition's doc must say what it writes outside the concert, since compose cannot see it.
- The operator's checkout sits behind `origin/main` after a release until it fetches.
- A dry run needs its own param, because a stub concert runs code nodes for real.
- The requirements gain the scope in HOST-03 and DIST-04, and `sdk-spec.md` states the code node rule.
