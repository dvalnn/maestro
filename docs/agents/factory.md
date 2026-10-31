# Factory

How the factory takes a ticket from the forge to a merged PR. A tick script drives it: each run reads the forge, routes
whatever a finished concert left, and starts at most one next action. The states are `state/` labels
(`triage-labels.md`), and the tick's transition table holds the same machine as data.

## Overview

A ticket's path. Bold edges are the owner's moves, gold states wait on the owner, green is done.

```mermaid
flowchart LR
    IN["intake"]
    GATE["needs-approval"]
    Q["ready-for-agent"]
    B["in-progress"]
    R["in-review"]
    D(["closed"])
    DUP(["duplicate"])
    NI["needs-info"]

    IN -->|"low, medium"| Q
    IN -->|"high, split"| GATE
    IN -->|dup| DUP
    GATE ==>|approve| Q
    Q -->|build| B
    B -->|PR| R
    B -->|"red ¹"| Q
    R ==>|"merge ²"| D
    R ==>|changes| B
    B -.->|"blocked ³"| NI
    IN -.->|"no spec"| NI
    NI ==>|"answer ⁴"| Q
    NI ==>|"answer ⁴"| IN

    classDef owner stroke:#d4a72c,stroke-width:3px
    classDef done stroke:#57ab5a,stroke-width:3px
    class GATE,NI owner
    class D done
```

1. With attempts left, or an infra fault.
2. By the owner, or by auto-merge on low risk.
3. Or out of attempts.
4. An answer to triage's questions goes back to intake; any other answer, or a closed obstacle, goes to the queue.

## Zoom 1: one tick

```mermaid
flowchart TD
    T(["timer"]) --> L{"locked?"}
    L -->|yes| X(["exit"])
    L -->|no| H{"halted? ¹"}
    H -->|yes| X
    H -->|no| C{"concert?"}
    C -->|running| X
    C -->|settled| S[["route (zoom 2)"]]
    C -->|none| SY
    S --> SY["sync ²"]
    SY --> P{"pick ³"}
    P --> E["encore"]
    P --> SL["build"]
    P --> TR["triage"]
    P --> HV["harvest"]
    P -->|nothing| X
    E & SL & TR & HV --> W["write back ⁴"] --> X
```

1. Halted by an infra fault, until its obstacle closes.
2. Merged PRs close issues, stacks rebase, closed blockers free tickets, an answer or a closed obstacle requeues a
   ticket, an approved split files its children, and an epic's last closed child closes it.
3. First match wins, in the order of the arrows: a concert to continue, a ready ticket whose blockers allow it, an
   intake issue, a harvest due.
4. Set the labels, rewrite the factory block.

## Zoom 2: routing a settle

Red marks the halt.

```mermaid
flowchart TD
    S(["settled"]) --> K{"concert"}
    K -->|triage| V{"verdict"}
    V -->|"low, medium"| RA["ready-for-agent"]
    V -->|"high, split"| NA["needs-approval"]
    V -->|dup| DU["duplicate"]
    V -->|"no spec"| NI1["needs-info"]
    K -->|slice| O{"outcome"}
    O -->|ok| LAND["land ¹"] --> IR["in-review"]
    O -->|red| A{"attempts left?"}
    A -->|yes| RA2["ready-for-agent"]
    A -->|no| NI2["needs-info"]
    O -->|blocked| NI3["needs-info ²"]
    O -->|infra| HALT["halt ³"]
    O -.->|any| REP["file reports ⁴"]
    K -->|harvest| PR["needs-approval ⁵"]

    classDef fault stroke:#e5534b,stroke-width:3px
    class HALT fault
```

1. In a workspace: apply, check, describe, push `factory/i<n>`, open the PR, arm auto-merge on low risk.
2. With the agent's question, blocked by its obstacle issue.
3. File the obstacle and requeue the ticket; the attempt is kept.
4. New obstacles and gaps, as `needs-triage`.
5. One issue per lesson promotion.

## Label reference

Each state is a `state/` label. A move replaces the label, since the scope is exclusive. The actors:

- **owner**: the human, or forge-bot acting for them.
- **tick**: the script, through forge-bot.
- **triage**, **slice**, **harvest**: the concerts the tick performs. The tick routes their outcome.

An edge in the diagrams names who causes the move; the tick sets the label unless the owner does it by hand.

| State             | Meaning                                             | Moved in by                         | Next                                                           |
| ----------------- | --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `needs-triage`    | Filed, not yet evaluated                            | owner, tick[^new], owner[^answer]   | `ready-for-agent`, `needs-approval`, `needs-info`, `duplicate` |
| `needs-spec`      | Wanted, needs design before work                    | owner                               | `ready-for-agent`, `needs-approval`, `needs-info`, `duplicate` |
| `needs-approval`  | Spec or split waits for the owner's go              | triage, harvest                     | `ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`  |
| `ready-for-agent` | Specified and queued for a slice concert            | triage, owner[^approve], tick[^red] | `in-progress`[^epic]                                           |
| `in-progress`     | Being built: a slice concert, or an epic's children | tick, owner[^changes]               | `in-review`, `ready-for-agent`, `needs-info`, closed[^epic]    |
| `in-review`       | PR open, waiting on CI and review                   | tick                                | `in-progress`, closed                                          |
| `needs-info`      | Waiting on an answer                                | triage, slice, tick, owner          | `ready-for-agent`[^answer], `needs-triage`[^answer]            |
| `ready-for-human` | Owner implements it, the factory never picks it up  | owner                               | closed                                                         |
| `wontfix`         | Will not be actioned                                | owner                               | closed                                                         |
| `duplicate`       | Repeats another issue, closed with a link           | triage                              | closed                                                         |

[^new]: The tick files obstacles, gaps and an approved split's children as `needs-triage`.

[^approve]: On approving a spec (`needs-approval`) or answering (`needs-info`).

[^epic]:
    When the owner approves a split, moving it to `ready-for-agent`, the tick files the children and moves the epic
    here. It closes when its last child does.

[^red]: A red run with attempts left or an infra fault, or a closed obstacle (`needs-info`).

[^changes]: The owner requesting changes on the PR moves `in-review` back here. The tick then runs an encore.

[^answer]:
    The owner answering triage's questions sends the ticket to `needs-triage`, since no spec exists yet. Any other
    answer by the owner, or the tick seeing its obstacle closed, sends it to `ready-for-agent` with the concert to
    continue.

Moves forward, then moves back. Gold states wait on the owner, green is done.

```mermaid
flowchart LR
    S(( )) -->|"[owner, tick] filed"| IN["intake ¹"]
    S -->|"[harvest] lesson"| NA["needs-approval"]
    IN -->|"[triage] high, split"| NA
    IN -->|"[triage] low, medium"| RA["ready-for-agent"]
    NA -->|"[owner] approve"| RA
    RA -->|"[tick] build"| IP["in-progress"]
    RA -->|"[tick] split approved"| IP
    IP -->|"[tick] PR"| IR["in-review"]
    IR -->|"[owner, auto-merge] merge"| CL(["closed"])
    IP -->|"[tick] epic done"| CL
    IN -->|"[triage] dup"| DU(["duplicate"])
    NA -->|"[owner] take, drop"| OUT(["ready-for-human, wontfix ²"])

    classDef owner stroke:#d4a72c,stroke-width:3px
    classDef done stroke:#57ab5a,stroke-width:3px
    class NA owner
    class CL done
```

```mermaid
flowchart LR
    IN["intake ¹"] -->|"[triage] no spec"| NI["needs-info"]
    NA["needs-approval"] -->|"[owner] ask"| NI
    IP["in-progress"] -->|"[slice, tick] blocked"| NI
    NI -->|"[owner] answer, [tick] obstacle closed"| RA["ready-for-agent"]
    NI -.->|"[owner] answer triage"| IN
    IP -->|"[slice] red, infra"| RA
    IR["in-review"] -->|"[owner] changes"| IP

    classDef owner stroke:#d4a72c,stroke-width:3px
    class NA,NI owner
```

1. `needs-triage` or `needs-spec`.
2. The owner may move any open issue here; the diagram draws it from `needs-approval` only.

Beside the state, an issue carries `kind/`, `risk/` and `area/` labels (`triage-labels.md`).

## Rules

- **Risk and tier.** `risk/low` is the `small` slice tier, `risk/medium` is `ordinary`, `risk/high` is `risky` (it sets
  a contract). Low builds, opens a PR and merges on CI and the slice's panel. Medium builds and waits for the owner's PR
  approval. High waits in `needs-approval` for the owner to approve the spec. Medium and high merge by rebase or
  fast-forward.
- **One concert at a time.** Parallel waves wait for 10 to 15 good runs.
- **Pick order.** Finish work first: an encore, then a build, then triage, then a harvest. A tick that routes a settle
  falls through and starts the next action.
- **Factory block.** Readable Markdown below the `<!-- factory -->` marker, ending in one `<!-- factory-data {...} -->`
  JSON line, the tick's only state: `concert`, the last concert it routed; `triage`, the last ok triage, which a
  re-triage continues; `result`, that triage's output; `pending`, set while the result's labels are not yet applied; and
  `filed`, an approved split's children. A line the tick cannot read halts the factory. The slice concert to continue
  joins it with the build: an answered `needs-info` or a closed blocking obstacle sets it, and a red retry clears it.
- **Encore.** A PR with changes requested, or a `ready-for-agent` ticket whose block names a concert to continue, runs
  an encore of that concert. With no concert to continue the build is a fresh perform.
- **Blockers.** A ticket is picked when every blocker (a forge dependency) is closed, or is `in-review`, in which case
  it stacks on that blocker's PR, two deep at most.
- **Attempts.** A red run spends an attempt and is retried with a fresh perform. After 2 attempts the ticket goes to
  `needs-info`.
- **Blocked.** A blocked agent moves its ticket to `needs-info` with its question and spends no attempt. An obstacle
  becomes a `needs-triage` issue that blocks the ticket, and its closing frees the ticket. An infra fault halts the
  factory until its obstacle closes.
- **Splits.** Triage records its verdict in the factory block: a spec, or a split with its child list. On the owner's
  approval of a split the tick files the children as `needs-triage`, in the epic's milestone with `Part of #N`, and
  moves the epic to `in-progress`. The epic closes when its last child does.
- **Duplicates and related issues.** A duplicate is closed at once as `state/duplicate` with a back-reference. A related
  issue gets `Relates to #N` in the factory block and the PR body.
- **Tour.** `<version>.i<n>`, such as `v0.1.0.i142`.
- **PRs.** One change per ticket, pushed by forge-bot as `factory/i<n>`, with the subject from the spec and `Closes #N`.

## Setting up

A new environment starts with manual shakedown runs: first with the stub harness, then with a cheap model, each watched
by hand. The tick does not enforce them.
