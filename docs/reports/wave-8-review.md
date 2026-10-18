# Wave 8 review: S8 repo host

One opus read-only pass over `jj diff --from tmzvuxkl --to mysmswsx`: S8e1 host core, S8f Claude adapter, S8e3 apply,
refs and agent checks, S8e2 host SDK. Data crossing the slices mostly agrees: the SDK emits what the host's schemas
accept, both adapters share one harness seam, and instance ids, lane versions and `ls` agree. The faults sat where a
later slice added a kind or an exit that an earlier slice's rule never learned, in docs still describing the host before
changeset and apply nodes, and in small copies across the adapters and the CLI.

## Findings

| #   | Kind | Finding                                                                                | Verdict                                        |
| --- | ---- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | code | Resume through an apply's version composes clean, then fails at perform after spend    | Raised: a joining check keeps the session[^2]  |
| 2   | code | Exit 137 is `failed` in an agent's `check` command but `rejected` on the check node    | Raised: `failed` in both, defined once         |
| 3   | doc  | Docs say every concert leaves a changeset; build-then-repair ends in a check           | Accepted                                       |
| 4   | doc  | D-21, HOST-02 and port-plan S8e predate `read`, apply and changeset nodes              | Accepted                                       |
| 5   | doc  | `changeset(v)` takes another concert's lane ref, which no requirement allows           | Raised: allowed, documented                    |
| 6   | code | Each adapter writes the token metric names and the JSON-line parse itself              | Accepted                                       |
| 7   | doc  | The 10-minute check timeout and the `HEAD` base are undocumented defaults              | Raised: no timeout by default; `HEAD` kept     |
| 8   | doc  | The CLI README omits the repo host's config, data dir and Claude token                 | Accepted                                       |
| 9   | code | Two CLI fixtures hand-write repo node config; the built-in host list is written twice  | Accepted                                       |
| 10  | doc  | sdk-spec 14's repo examples contradict 12.1                                            | Accepted                                       |
| 11  | code | A rejecting agent missing a declared file loses its lane and report; docs say `failed` | Raised: a correction turn, then no outputs[^3] |
| 12  | code | The duration examples are copied into four messages                                    | Accepted                                       |

## Loop

| Step                       | Findings | Accepted    | Changed code or design                            | Spend[^1]           |
| -------------------------- | -------- | ----------- | ------------------------------------------------- | ------------------- |
| Wave review                | 12       | 7, 5 raised | code (validate, check exits, adapters, CLI); docs | opus, 209k, 8 min   |
| Fixes                      | —        | —           | 12 findings                                       | sonnet, 172k, 6 min |
| Fix review                 | 11       | 11          | docs, one test, a resume error naming its node    | opus, 331k, 8 min   |
| Fix round 1                | —        | —           | 11 findings                                       | sonnet, 184k, 1 min |
| Rejected-outputs follow-up | —        | —           | agent correction turn                             | sonnet, 223k, 2 min |

[^1]: Model, then tokens and wall time from each agent's notice; the fix review sums its three passes.

[^2]: Apply passes on no session; validate refuses resume from any other writer, naming the refusing node.

[^3]: Core stays as it is: a rejection carries all its outputs or none. The correction shares the envelope's two turns.
