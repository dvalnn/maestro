# Triage labels

The skills speak of canonical roles: a **category** saying what kind of request it is, and a **state** saying where it
sits. A triaged issue carries exactly one of each. Each family is an exclusive label scope on the forge, so the forge
keeps it to one.

| Role              | Label                   | Meaning                                  |
| ----------------- | ----------------------- | ---------------------------------------- |
| `bug`             | `kind/bug`              | Something is broken                      |
| `enhancement`     | `kind/enhancement`      | New feature or improvement               |
| `needs-triage`    | `state/needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | `state/needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `state/ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `state/ready-for-human` | Requires human implementation            |
| `needs-spec`      | `state/needs-spec`      | Wanted, but needs design before work     |
| `wontfix`         | `state/wontfix`         | Will not be actioned; close it too       |

"Done" is the forge's closed state, not a label. A closed issue keeps its `kind/` label and drops its `state/` one,
unless it is `state/wontfix`.

A state says how ready an issue is, never when it ships: the milestone says that (`issue-tracker.md`). An open issue
with no milestone is icebox; no label marks it.

Read the forge's list before using a name: `fj` refuses a label the repo does not have.
