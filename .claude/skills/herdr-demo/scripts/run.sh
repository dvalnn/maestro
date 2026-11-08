#!/usr/bin/env bash
# Performs a composition in the left pane, watches it in the right, waits, and prints both panes.
# Usage: run.sh <left> <right> <workdir> [--timeout <d>] -- <perform args...>     (timeout default 10m)
# Exits with `maestro wait`'s code.
set -euo pipefail

id_timeout=60
lines_right=40
lines_left=15
uuid='concert [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'

die() { echo "run.sh: $1" >&2; exit 1; }

[[ $# -ge 5 ]] || die "usage: run.sh <left> <right> <workdir> [--timeout <d>] -- <perform args...>"
left=$1 right=$2 workdir=$3
shift 3
timeout=10m
if [[ $1 == --timeout ]]; then
  timeout=${2:?--timeout needs a duration such as 90s}
  shift 2
fi
[[ ${1:-} == -- ]] || die "put '--' before the perform args"
shift
[[ $# -gt 0 ]] || die "no perform args; pass the composition, flags and --title"
[[ -d $workdir ]] || die "no workdir $workdir; run scripts/toy.sh first"
maestro=$(cd "$workdir/.." && pwd)/bin/maestro
[[ -x $maestro ]] || die "no release binary at $maestro; run scripts/setup.sh first"

quote() { printf "'%s' " "${@//\'/\'\\\'\'}"; }
concerts() { herdr pane read "$left" --lines 300 | grep -oE "$uuid" | awk '{print $2}' || true; }

before=$(concerts | grep -c . || true)
herdr pane run "$left" "$(quote "$maestro") perform $(quote "$@")" >/dev/null

id=
for ((i = 0; i < id_timeout; i++)); do
  all=$(concerts)
  if [[ $(grep -c . <<<"$all" || true) -gt $before ]]; then
    id=$(tail -1 <<<"$all")
    break
  fi
  sleep 1
done
[[ -n $id ]] || die "no concert id in pane $left after ${id_timeout}s; read it with 'herdr pane read $left --lines 40'"

herdr pane run "$right" "$(quote "$maestro") watch $id" >/dev/null
echo "concert $id"

code=0
(cd "$workdir" && "$maestro" wait "$id" --timeout "$timeout") || code=$?
sleep 1
echo "--- right pane ($right)"
herdr pane read "$right" --lines "$lines_right"
echo "--- left pane ($left)"
herdr pane read "$left" --lines "$lines_left"
exit "$code"
