# Spike 3: compiled binary loads an external pack bundle

Verdict: **go** (host and rockylinux:8 container; kernel 4.18 pending real RHEL 8 run per spec).

Code: `.scratch/s0-skeleton-spikes/spike3/` (`build.sh` -> `out/spike3`, packs in `out/pack`, `out/pack-bad`,
`out/pack-ts`). No args = full self-test; the pack is located from `dirname(process.execPath)`. `spike3 <packdir>` loads
one pack only.

## Commands and output

```
$ .scratch/s0-skeleton-spikes/spike3/build.sh        # bun build pack -> out/pack/index.js (inlines stand-in SDK), then bun build --compile
$ out/spike3; echo exit=$?
PASS a dynamic import of external entry pack=pack@0.0.1
PASS a code node runs out=X
PASS c node:path builtin inside pack
PASS b instanceof across copies is false
PASS b structural check is true
captured: Cannot find package 'left-pad' imported from /home/taamorim/forge/maestro/.scratch/s0-skeleton-spikes/spike3/out/pack-bad/index.js
PASS d bare specifier errors
INFO ts entry loads: TS
exit=0

$ docker run --rm -v $PWD/out:/o:ro rockylinux:8 sh -c '/o/spike3; echo exit=$?'   # Rocky Linux release 8.9
(identical output, path /o/pack-bad/index.js)
exit=0
```

## Findings

- (a) `await import(absolutePath)` of an external `.js` works from a compiled binary, no `node_modules` anywhere near
  the pack.
- (b) The host and pack SDK copies coexist. `node instanceof CodeNode` (host copy) is **false**; the structural check
  (`kind === "code"`, `typeof run === "function"`) is true. Confirms ADR 0002.
- (c) `node:path` imported inside the pack works (pack built with `--target=bun`, builtins stay external).
- (d) Un-bundled bare specifier fails at import time with `Cannot find package 'left-pad' imported from <entry path>`.
  Clear, names the specifier and the file.
- (e) A `.ts` entry also loads (the compiled Bun runtime transpiles it, including a relative `./sdk` import). Decision
  stays pre-bundled JS.

## Caveats

- Bare-specifier resolution walks up from the entry file, so a pack placed under a directory tree that has an ancestor
  `node_modules` could resolve silently (not tested). The loader should not rely on the error for isolation.
- The TS-entry result is Bun-specific behaviour; it was not exercised with relative imports outside the pack dir.
- Stand-in SDK only (6 lines); no real SDK or IR validation was exercised.
- Check (c) reuses check (a)'s assertion rather than testing `node:path` independently. Check (d) asserts only that an
  error is thrown, not its message.

## Follow-ups

- Pack loader: validate the manifest (name, version, entry) by schema, resolve `entry` against the pack dir, wrap import
  errors with the pack name, and detect code nodes structurally (use a discriminant such as `kind`, not `instanceof`).
- Pack loader: consider rejecting entry paths escaping the pack dir.
- S9: build packs with `bun build --target=bun --format=esm` (no `--external` except deliberate); add a check that a
  pack bundle has no leftover bare imports; test an ancestor `node_modules` case.
- Run `spike3` on a real RHEL 8 host via the sibling script (no args).
