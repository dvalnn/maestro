# Triage labels

The skills speak of canonical roles: a **category** saying what kind of request it is, and a **state** saying where it
sits. A triaged issue carries exactly one of each. Each family is an exclusive label scope on the forge, so the forge
keeps it to one.

| Role              | Label                   | Meaning                                            |
| ----------------- | ----------------------- | -------------------------------------------------- |
| `bug`             | `kind/bug`              | Something is broken                                |
| `enhancement`     | `kind/enhancement`      | New feature or improvement                         |
| `needs-triage`    | `state/needs-triage`    | Maintainer needs to evaluate this issue            |
| `needs-info`      | `state/needs-info`      | Waiting on reporter for more information           |
| `ready-for-agent` | `state/ready-for-agent` | Fully specified, ready for an AFK agent            |
| `ready-for-human` | `state/ready-for-human` | Requires human implementation                      |
| `needs-spec`      | `state/needs-spec`      | Wanted, but needs design before work               |
| `wontfix`         | `state/wontfix`         | Will not be actioned; close it too                 |
| `needs-approval`  | `state/needs-approval`  | Spec or split waits for the owner's go             |
| `in-progress`     | `state/in-progress`     | Being built: a slice concert or an epic's children |
| `in-review`       | `state/in-review`       | PR open, waiting on CI and review                  |
| `duplicate`       | `state/duplicate`       | Repeats another issue; close it too                |
| `epic`            | `kind/epic`             | An ask split into child issues                     |

"Done" is the forge's closed state, not a label. A closed issue keeps its `kind/` label and drops its `state/` one,
unless it is `state/wontfix` or `state/duplicate`; `.forgejo/workflows/clear-state-on-close.yml` does the dropping when
an issue closes.

A state says how ready an issue is, never when it ships: the milestone says that (`issue-tracker.md`). An open issue
with no milestone is icebox; no label marks it.

`state/ready-for-human` means the tour manager never takes the issue. `state/needs-approval`, `state/in-progress` and
`state/in-review` belong to the tour manager, whose state machine and label moves are in `factory.md`.

`maestro-tm:halt` sits outside both families: it marks the open issue the tour manager files when it halts, and closing
that issue lifts the halt.

Two more exclusive scopes sit beside `kind/` and `state/`:

| Scope   | Labels                                                              | Meaning                             |
| ------- | ------------------------------------------------------------------- | ----------------------------------- |
| `risk/` | `risk/low`, `risk/medium`, `risk/high`                              | How far the tour manager goes alone |
| `area/` | `area/core`, `area/cli`, `area/host`, `area/packs`, `area/docs`[^a] | The part of the codebase it touches |

[^a]:
    `core` covers `ir`, `core`, `sdk` and `testkit`; `cli` covers `cli` and `render-text`; `host` covers `host-repo`,
    `host-repo-sdk` and the harnesses.

Read the forge's list before using a name: `fj` refuses a label the repo does not have.
