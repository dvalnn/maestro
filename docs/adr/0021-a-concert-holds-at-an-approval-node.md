---
status: accepted
---

# A concert holds at an approval node until an operator rules

A release publishes: it pushes `main`, creates the forge release and closes the milestone. None of that can be taken
back, so the owner must say go between the candidate and the publish. Today that go lives in a skill's step list,
outside any concert. The graph cannot show it, compose cannot bound it, and the record does not hold it.

The rule is:

- **`approval` is an engine node kind.** It has a build-time `prompt`, data inputs and no outputs. The prompt is a
  non-empty literal in the IR, so it is part of the node's definition. The inputs are what the operator rules on. A
  dependent reads the node's status ports or follows a `control` edge.
- **An approval settles by a ruling.** A ruling is `ok`, or `rejected` with a reason. A `rejected` ruling is a negative
  verdict by ADR 0012, and its reason is the concert's root cause by the result rule.
- **The node holds as `running`.** The executor writes an approval request to the record store and emits one `awaiting`
  event. It then polls the store at a named interval until a ruling lands. There is no fifth state and no timeout. A
  held instance takes no place under the concurrency cap.
- **`kill` ends a hold.** A killed concert settles the held instance `failed`, as it settles any running instance.
- **One `Records` method writes a ruling.** The first ruling wins and a second one is refused. A settled or killed
  instance refuses a ruling. A ruling counts only for the resume key the request was made under.
- **A resume asks again unless the instance is reused.** A recorded `ok` approval whose resume key still matches is
  reused by CORE-09. Any other resume replaces the request, so a ruling given on old inputs never passes new ones.
- **Compose bounds approvals.** The plan reports `up to N approvals`, so an operator knows before any spend how often
  the concert can hold. The count is named `approvals`, and a cap of that name bounds it.
- **One CLI verb lists and rules.** `maestro approval` lists the open requests. Given a concert id it rules. Any other
  front-end is out of scope.

## Why a node kind

NFR-09 asks for a reason. A hold needs four things that no code node has:

- a row that another process can list and answer;
- an event that a renderer can draw;
- a bound that compose reports;
- a ruling tied to the resume key.

The engine gives a code node none of them, so each author would write all four by hand.

## Considered options

- **Two concerts with the operator between them.** The first builds the candidate and the second publishes. Rejected:
  the go stays a convention outside the graph, and the second concert needs the first one's results, which ADR 0015
  defers.
- **A code node that polls a file or the forge.** Rejected: it holds a worker and nothing lists it. Compose cannot bound
  it, and each author writes the resume rule again.
- **A host node kind in the repo host.** Rejected: waiting for a person is no coding-agent concern. The core's own suite
  runs with a fake host only (CORE-12), so it could not test the hold.
- **An `awaiting` state or outcome.** Rejected as ADR 0012 rejected `blocked`: every consumer of states and outcomes
  would change for one node kind. `running` with one event says the same.
- **The concert exits while it waits, and the ruling resumes it.** Rejected: the ruling verb becomes a second way to
  perform. It would need its own config, harness and exit code. A held process costs nothing.
- **An approval that returns typed answers.** Deferred: no composition needs more than go or no-go yet. Outputs can be
  added in a later IR minor without breaking this shape.

## Consequences

- The process that performs the concert must stay alive while it holds, so a concert with an approval is performed with
  `--detach`.
- A held concert waits until it is ruled or killed. `wait` returns its timeout exit code while the concert holds.
- An operator is a person or a conductor (requirements, Actors). The engine cannot tell them apart, so an approval
  proves that an operator ruled, not that a person did.
- `ok` reuse means a resume after a publish step failed does not ask the owner again for the same candidate.
- The IR gains a kind in a new minor version, and a reader of an older minor refuses it (ADR 0004).
