---
status: accepted
---

# Compose runs no author code

Compose used to fold pure code nodes: a code node whose inputs were all known at compose time ran there, so the plan
could expand a group its result sized. Code nodes were pure by default and declared `pure: false` to opt out.

Folding is dropped, with node purity and the IR's `pure` field. Code nodes run only at perform.

- **Purity cannot be checked.** TypeScript cannot tell a pure function from one that prints, writes a file or calls the
  network. A node left pure by default ran its side effects at compose, which must have none (CORE-07), and again at
  perform.
- **Folding sees nothing build does not.** Params and composed config are plain values at build (D-16), so the build
  function can compute any value a fold could, and shape the graph with it. A group sized by a node result stays a
  bounded region (CORE-05).

Compose still loads every code node's function, so a worker reference that names nothing is a compose error.

## Considered options

- **Keep folding, impure by default.** Authors opt in with `pure: true`. The flag stays unchecked, and an author who
  sets it on a node that prints or writes gets the same double run.
- **Keep folding, and detect ambient reads at fold time.** Catches the clock and the environment, never a print, a file
  write or a network call.

## Consequences

- `assert` is decided at build when its condition is a plain value, and at perform otherwise.
- A `map` key function runs at perform too. Compose knows a build-time list's length, so the group still expands to an
  exact count, but duplicate keys a key function gives fail the `map` at perform rather than stop compose.
- Every code node may read the clock and the concert id from its context.
- The plan shows no folded values, and `compose` never runs or times out an author's function.
- The IR loses `pure` within 1.0, since no IR has been released outside this repository.
- Build-time ambient state stays frozen (SDK-11): build still runs author code, and its IR must be deterministic.
