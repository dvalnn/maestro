#!/usr/bin/env bash
# Points GitHub's `next` at <rev> of main@origin (main@origin by default) and pushes it, then abandons the GitHub
# commits it replaced. Refuses while `next` holds a commit not landed on <rev>; --landed overrides, for one squashed or
# reworked on landing. Procedure: .claude/skills/github/SKILL.md.
set -euo pipefail

REMOTE=github
BRANCH=next
USAGE="usage: github-sync.sh [--landed] [<rev>]"
# Landing rewrites a commit but keeps its author, so author and author time pair a GitHub commit with its landed copy.
IDENTITY='author.email() ++ " " ++ author.timestamp().utc().format("%s")'

# Forgetting leaves next@github untracked, so `jj rmain` and `jj git push --tracked` never rewrite or push it, even
# after a failed push.
forget_on_exit() { trap 'jj bookmark forget "$BRANCH"' EXIT; }

fail() {
  printf 'github-sync: error: %s\n' "$1" >&2
  [ $# -lt 2 ] || printf '%s\n' "$2" >&2
  exit 1
}

landed=
rev=main@origin
for arg in "$@"; do
  case $arg in
    --landed) landed=1 ;;
    -*) fail "unknown flag $arg" "$USAGE" ;;
    *) rev=$arg ;;
  esac
done

jj git remote list | grep -q "^$REMOTE " ||
  fail "no remote named $REMOTE" "Add it: jj git remote add $REMOTE git@github.com:dvalnn/maestro.git"
jj git fetch --remote origin --remote "$REMOTE"
[ -n "$(jj log --no-graph -r "($rev) & ::main@origin" -T 'commit_id')" ] ||
  fail "$rev is not on main@origin" "Land it on the forge first, or pass a revision of main@origin"

remote_ref="$BRANCH@$REMOTE"
replaced=
if [ -n "$(jj log --no-graph -r "present($remote_ref)" -T 'commit_id')" ]; then
  replaced="::$(jj log --no-graph -r "$remote_ref" -T 'commit_id') ~ ::main@origin"
  on_rev=$(jj log --no-graph -r "fork_point($remote_ref | ($rev))::($rev)" -T "$IDENTITY ++ \"\n\"")
  unlanded=$(
    jj log --no-graph -r "$replaced" \
      -T "$IDENTITY ++ \"\t\" ++ commit_id.short() ++ \" \" ++ description.first_line() ++ \"\n\"" |
      while IFS=$'\t' read -r identity commit; do
        grep -qxF "$identity" <<<"$on_rev" || printf '%s\n' "$commit"
      done
  )
  if [ -n "$unlanded" ] && [ -z "$landed" ]; then
    printf '%s\n' "$unlanded" >&2
    fail "$remote_ref has commits not landed on $rev" \
      "Land them (github skill, Intake), or pass --landed if they landed squashed or reworked"
  fi
  forget_on_exit
  jj bookmark track "$remote_ref"
  jj bookmark set "$BRANCH" -r "$rev" --allow-backwards
else
  forget_on_exit
  jj bookmark set "$BRANCH" -r "$rev"
  jj bookmark track "$remote_ref"
fi
jj git push --remote "$REMOTE" --bookmark "$BRANCH"
[ -z "$replaced" ] || jj abandon "$replaced"
