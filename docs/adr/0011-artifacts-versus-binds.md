---
status: accepted
---

# What an agent reads is an artifact, what it runs on is a bind

An agent's sandbox can see paths outside its lane, and two mechanisms put them there: a node's `attachments` and the
binds (`readOnly` on a node, config or check, and `writable` on a check). Without a rule, a pack author would reach for
whichever is nearer, and a changed input could then fail to rerun the nodes that read it.

The rule is:

- **An attachment is an artifact.** It is an input port of the node, fed by an artifact output or a literal, so its
  content hash is in the node's resume key (CORE-09). The host mounts it read-only at `/in/<name>`, and the staged
  prompt lists it with its required `hint`. It is what the agent's answer depends on: a spec, a knowledge set, an
  earlier agent's notes.
- **A bind is the environment.** It is a host path named in config or a check, mounted at its own path. It is not an
  input and not in the resume key. It is what the agent or check runs on: a toolchain, a cache, an SDK rebuilt in place,
  a lock file shared across lanes. `writable` is named by config or a check node, never by an agent node, and an agent
  that may run the check gets its binds (HOST-04, HOST-15).
- **A check's output directory is writable while the check runs and kept as an artifact after.** It is made by the check
  node under its scratch, outside the lane, named in `MAESTRO_CHECK_OUTPUT`, and is not a bind.
- **Compose refuses a bind that is relative, missing or inside the lanes, and a writable one that also contains or lies
  inside the lanes or the target repository** (HOST-03, HOST-11). An attachment needs no such rule: the concert owns the
  artifact.

## Considered options

- **Attachments as read-only binds of a path.** The content would stay out of the resume key, so editing a reference
  would leave a warm node's result in place. Rejected.
- **Toolchains and caches as artifacts.** Each would be copied into the artifact area and hashed on every run, and a
  cache could not be written back. Rejected.
- **Writable binds on agent nodes.** A pack could then widen an agent's write access per node (HOST-04). They stay on
  config and check nodes, whose lines are trusted pack or target code, and an agent gets them only by being allowed to
  run those checks.

## Consequences

- A pack that wants a changed file to rerun a node passes it as an attachment. A bind never does, so a check whose
  result depends on a bind's content is not reproduced by resume.
- A writable bind is state shared by every lane that mounts it, which is its purpose and the operator's to keep
  consistent. Per-target caches that maestro itself manages are left for later.
