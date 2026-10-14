# Loader rules for code references

Status: ready-for-human

ADR 0008 leaves `resolveCode(fn)` and `loadCode(ref)` to the loader. Rulings and findings to carry into the slice that
builds it:

- An IR file: `loadCode` checks the module against `codeHash` and errors when they differ (owner, 2026-10-16). A helper
  that fills in the hashes of a hand-written IR file comes later.
- Another pack's subcomposition: the using pack imports its source and bundles it (owner, W2). A spike showed Bun keeps
  `export * as b from "<pack>"` as a plain object, not a module namespace, and that `b.fn` is the same function the
  inlined subcomposition holds. So a lookup by identity walks object exports one level down.
- The same function can be reachable under two names, such as `found` and `b.score`. The loader needs a fixed rule:
  first name in sorted order, or an error.
- Still to decide:
  - what `module` is relative to, for a pack bundle, a bare `.ts` file and an IR file;
  - how `codeHash` covers a bare file's imports (bundle it in memory first);
  - whether a bundle-wide hash meets S5's "exactly the affected nodes";
  - whose config namespace a subcomposition from another pack reads, its own pack's or the using pack's (S6).
- The worker call shape: the S1d fixture modules take one object of input ports and return one object of output ports,
  and a `map` key function takes the item and returns its key. That is a placeholder until the worker interface (S34)
  fixes it.
- What a node's `source.file` is relative to. The fixtures still say `fixtures/guards.ts` while `module` is relative to
  the IR file.
