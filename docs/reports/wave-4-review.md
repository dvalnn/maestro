# Wave 4 review: S5 resume, S6a loader and config, S6b CLI verbs

One opus read-only pass over `jj diff --from ryklzkyo --to wnwnnlmn`, against the docs, the ADRs and the rulings. The
seams between S5 and S6 hold: the resume key, record schema 3, the concert's origin and its code location agree end to
end and are tested. The faults sit at the bundle boundary and in docs that lag the rulings.

A demo of the CLI the same day found two more defects no test caught: a bare file's config key broke every other target,
and pure code nodes ran twice, once folded at compose and again at perform. The second led the owner to drop node purity
and folding altogether.

## Findings

| #   | Kind | Finding                                                                        | Verdict                     |
| --- | ---- | ------------------------------------------------------------------------------ | --------------------------- |
| 1   | code | A bundle's build diagnostic prints the whole base64 bundle as its file         | Accepted, S6c               |
| 2   | code | A bare file's stem is not checked against the id pattern or installed packs    | Accepted, S6c               |
| 3   | code | A pack's host version ranges are never checked: nothing supplies host versions | Raised                      |
| 4   | doc  | `tour` has no alias, against D-14 and CLI-07                                   | Raised                      |
| 5   | code | The IR's worker references are walked twice, in core and in the CLI            | Accepted, S6c               |
| 6   | code | The resume refusal is written twice, and the IR is rehashed twice              | Accepted, S6c               |
| 7   | code | Compose scratch sits in the OS temp directory                                  | Moot: compose stops folding |
| 8   | doc  | Only `kill` tells maestro from another program, against the brief's wording    | Accepted, docs              |
| 9   | doc  | The CLI README calls `caps` host capabilities and omits `prune`'s flags        | Accepted, S6c               |
| 10  | doc  | Architecture, D-30 and the glossary lag K58, K62, K88, K90 and K91             | Accepted, docs              |
| 11  | code | Core's internal helper module became public API for two helpers                | Accepted, S6c               |
| 12  | code | `ls` shows and filters compositions without their pack                         | Accepted, S6c               |

## Loop

| Step        | Findings | Accepted    | Changed code or design                   | Spend[^1]       |
| ----------- | -------- | ----------- | ---------------------------------------- | --------------- |
| Wave review | 12       | 9, 2 raised | code (S6c); design (node purity dropped) | 210k tok, 8 min |

[^1]: Tokens and wall time from the agent's completion notice.
