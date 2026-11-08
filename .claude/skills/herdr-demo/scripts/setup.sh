#!/usr/bin/env bash
# Prints "<left> <right>": the two pane ids of the herdr workspace maestro-<name>, made if missing.
# Usage: setup.sh <name>     env: MAESTRO_DEMO_ROOT (default ~/Projects/maestro-ac)
set -euo pipefail

root=${MAESTRO_DEMO_ROOT:-$HOME/Projects/maestro-ac}
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
release=$repo/dist/maestro-linux-x64.gz

die() { echo "setup.sh: $1" >&2; exit 1; }

[[ $# -eq 1 ]] || die "usage: setup.sh <name>"
name=$1
dir=$root/$name
label=maestro-$name
[[ -d $dir ]] || die "no demo dir $dir; run scripts/toy.sh <t1|t2> $name first"
[[ -f $release ]] || die "no release binary at $release; run 'just release'"

mkdir -p "$root/bin"
gzip -dc "$release" > "$root/bin/maestro"
chmod +x "$root/bin/maestro"

ws=$(herdr workspace list | jq -r --arg l "$label" '.result.workspaces[] | select(.label == $l) | .workspace_id' | head -1)
if [[ -z $ws ]]; then
  ws=$(herdr workspace create --cwd "$dir" --label "$label" --no-focus |
    jq -r '.result.workspace.workspace_id // .result.root_pane.workspace_id')
fi
[[ -n $ws && $ws != null ]] || die "herdr workspace create gave no id; check 'herdr status'"

panes=$(herdr pane list --workspace "$ws" | jq -r '.result.panes[].pane_id')
left=$(sed -n 1p <<<"$panes")
right=$(sed -n 2p <<<"$panes")
if [[ -z $right ]]; then
  right=$(herdr pane split "$left" --direction right --cwd "$dir" --no-focus |
    jq -r '.result.pane.pane_id')
fi
[[ -n $left && -n $right && $right != null ]] || die "workspace $label has no two panes; close it with 'herdr workspace close $ws' and rerun"
echo "$left $right"
