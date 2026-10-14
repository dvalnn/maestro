#!/usr/bin/env python3
"""Deny the git verbs jj owns in this colocated repo, naming the replacement.

A `PreToolUse` hook on `Bash`. Read-only git is untouched — `log`, `status`,
`diff`, `show`, `rev-parse` and everything else not listed below still run.

`ALLOW_GIT=1 git <verb> ...` is the escape hatch, for the cases jj has no
answer for. It is a prefix on the command, so it shows up in the transcript.
"""

from __future__ import annotations

import json
import re
import shlex
import sys

# The verb that rewrites history or moves a ref, and the jj that does it.
JJ = {
    "add": "the working copy is already tracked — there is nothing to stage",
    "am": "`jj new`, then apply the patch into the working copy",
    "branch": "`jj bookmark set|list|delete <name>`",
    "checkout": "`jj edit <rev>` to work on a commit, `jj new <rev>` to start one on top",
    "cherry-pick": "`jj duplicate <rev> -d <dest>`",
    "clean": "`jj restore` — the working copy is a commit",
    "commit": "`jj commit -m ...`, or `jj describe` to name the working copy;"
    " `--amend` is `jj describe` or `jj squash`",
    "fetch": "`jj git fetch`",
    "merge": "`jj new <rev1> <rev2>`",
    "mv": "move the file with `mv`; jj picks the rename up by itself",
    "pull": "`jj git fetch`, then `jj rebase -d <base>`",
    "push": "`jj git push --tracked` for everything a rebase touched,"
    " `-b <name>` for one, `--deleted` to propagate a `jj bookmark delete`",
    "rebase": "`jj rebase -d <base>` — the PR's own base, which is `main@origin`"
    " only at the bottom of a stack",
    "reset": "`jj restore` for files, `jj abandon` for a commit, `jj undo` for the last operation",
    "restore": "`jj restore`",
    "revert": "`jj backout -r <rev>`",
    "rm": "delete the file; jj notices",
    "stash": "`jj new` — the working copy is already a commit, so there is nothing to stash",
    "switch": "`jj edit <rev>` or `jj new <rev>`",
    "tag": "`jj tag list` reads them; jj does not create tags — use the forge's release",
}

# git's own options before the subcommand; these two swallow the next word.
GLOBAL_WITH_VALUE = {
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
}

SPLIT = re.compile(r"&&|\|\||[;|\n]")


def subcommands(command: str) -> list[str]:
    """Every git subcommand invoked anywhere in a compound shell command."""
    found = []
    for segment in SPLIT.split(command):
        try:
            words = shlex.split(segment)
        except ValueError:  # unbalanced quotes — let the shell complain, not us
            continue
        while words and ("=" in words[0] and not words[0].startswith("-")):
            words.pop(0)  # VAR=value prefixes
        if not words or words[0] != "git":
            continue
        words = words[1:]
        while words:
            if words[0] in GLOBAL_WITH_VALUE:
                words = words[2:]
            elif words[0].startswith("-"):
                words = words[1:]
            else:
                found.append(words[0])
                break
    return found


def main() -> None:
    request = json.load(sys.stdin)
    if request.get("tool_name") != "Bash":
        sys.exit(0)

    command = request.get("tool_input", {}).get("command", "")
    if re.search(r"\bALLOW_GIT=1\b", command):
        sys.exit(0)

    denied = [verb for verb in subcommands(command) if verb in JJ]
    if not denied:
        sys.exit(0)

    reason = (
        "This repo is jj-colocated; git is denied where jj owns the operation.\n"
        + "\n".join(f"- `git {verb}` -> {JJ[verb]}" for verb in dict.fromkeys(denied))
    )
    reason += "\n\nRead-only git is fine. `ALLOW_GIT=1 <command>` overrides this, deliberately."

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


if __name__ == "__main__":
    main()
