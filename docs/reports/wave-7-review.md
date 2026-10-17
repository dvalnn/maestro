# Wave 7 review: S7 core gate

One opus read-only pass over `jj diff --from ouuttomm --to nmxlxutm`: S7b core API, S7c SDK API, S7d formats and lints,
S7e test kit and Host reference. The host contract holds end to end: hooks, setup and resources agree across ADR 0010,
architecture 6, CORE-13, the glossary, core, the CLI and the fake host, and no renamed or cut name survives. The faults
sat where one slice's move outran another's docs, and in two test-kit helpers that drifted from what the CLI does.

## Findings

| #   | Kind | Finding                                                                                                  | Verdict                           |
| --- | ---- | -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | doc  | The layer table disagrees with the import lints and the Host reference                                   | Accepted                          |
| 2   | code | `Settling` is exported though nothing outside core uses it, and restates a type                          | Accepted                          |
| 3   | code | `composeIr` refuses core config that `maestro compose` accepts                                           | Accepted                          |
| 4   | code | `buildIr` builds once where the loader builds twice                                                      | Accepted                          |
| 5   | doc  | The render-text README and port-plan lag the plan goldens' move and `watch` in V1                        | Accepted                          |
| 6   | code | `@maestro/core/worker` no longer holds a worker                                                          | Raised: renamed `core/node`       |
| 7   | doc  | The Host reference's imports omit `ArtifactRef`                                                          | Accepted                          |
| 8   | doc  | The IR changelog has no line for the removed `tag`                                                       | Accepted                          |
| 9   | doc  | The domain-word lint scans render-text, which CORE-12 does not name; sdk-spec 6 omits the stdlib subpath | Raised: renderers named; accepted |

## Loop

| Step        | Findings | Accepted    | Changed code or design                         | Spend[^1]       |
| ----------- | -------- | ----------- | ---------------------------------------------- | --------------- |
| Wave review | 9        | 7, 2 raised | code (test kit, exports); design (`core/node`) | 181k tok, 7 min |
| Fixes       | —        | —           | 9 findings                                     | 155k tok, 5 min |

[^1]: Tokens and wall time from the agent's completion notice.
