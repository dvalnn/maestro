# Triage labels

For agents and the owner: the label set and what each label means. Skills speak of roles: a **category** (what kind of
request) and a **state** (where it sits). A triaged issue carries one of each; each is an exclusive label scope, so the
forge keeps it to one.

| Role              | Label                   | Meaning                                              |
| ----------------- | ----------------------- | ---------------------------------------------------- |
| `bug`             | `kind/bug`              | Something is broken                                  |
| `enhancement`     | `kind/enhancement`      | New feature or improvement                           |
| `needs-triage`    | `state/needs-triage`    | Filed or sent back; waits for triage                 |
| `needs-info`      | `state/needs-info`      | Waiting on the owner's answer to a question          |
| `ready-for-agent` | `state/ready-for-agent` | Triaged and specified; the tick builds it            |
| `ready-for-human` | `state/ready-for-human` | The owner builds it; the tour manager never takes it |
| `wontfix`         | `state/wontfix`         | Will not be actioned; close it too                   |
| `needs-approval`  | `state/needs-approval`  | Spec or split waits for the owner's go               |
| `in-progress`     | `state/in-progress`     | Being built: a slice concert or an epic's children   |
| `in-review`       | `state/in-review`       | PR open, waiting on CI and review                    |
| `duplicate`       | `state/duplicate`       | Repeats another issue; close it too                  |
| `epic`            | `kind/epic`             | An ask split into child issues                       |

"Done" is the forge's closed state, not a label. On close, `.forgejo/workflows/clear-state-on-close.yml` drops the
`state/` label, unless it is `state/wontfix` or `state/duplicate`; the `kind/` label stays.

A state says how ready an issue is, never when it ships: the milestone says that (`issue-tracker.md`).

`state/needs-approval`, `state/in-progress` and `state/in-review` belong to the tour manager. Its state machine and what
each label makes it do are in `factory.md`.

`maestro-tm:halt` and `maestro-tm:harvest` sit outside both families. The first marks the issue the tour manager files
when it halts; closing it lifts the halt. The second marks an issue a harvest filed.

Two more exclusive scopes sit beside `kind/` and `state/`:

| Scope   | Labels                                                                              | Meaning                             |
| ------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| `risk/` | `risk/low`, `risk/medium`, `risk/high`                                              | How far the tour manager goes alone |
| `area/` | `area/core`, `area/cli`, `area/host`, `area/packs`, `area/docs`, `area/factory`[^a] | The part of the codebase it touches |

[^a]:
    `core` covers `ir`, `core`, `sdk` and `testkit`; `cli` covers `cli` and `render-text`; `host` covers `host-repo`,
    `host-repo-sdk` and the harnesses; `factory` covers `scripts/factory/` and `.maestro/`.

`fj` refuses a label the repo does not have; read the forge's list first.
