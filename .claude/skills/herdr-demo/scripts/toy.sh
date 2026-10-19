#!/usr/bin/env bash
# Makes a toy maestro workspace at <demo root>/<name> and prints the perform line.
# Usage: toy.sh <t1|t2> <name> [--harness <h> --model <m>]   default: --harness stub --model none
# A real harness spends money: it needs MAESTRO_DEMO_GO=1, set only on the owner's explicit go.
set -euo pipefail

root=${MAESTRO_DEMO_ROOT:-$HOME/Projects/maestro-ac}
repo=$(cd "$(dirname "$0")/../../../.." && pwd)

die() { echo "toy.sh: $1" >&2; exit 1; }

[[ $# -ge 2 ]] || die "usage: toy.sh <t1|t2> <name> [--harness <h> --model <m>]"
task=$1 name=$2
shift 2
args=("$@")
[[ ${#args[@]} -gt 0 ]] || args=(--harness stub --model none)

harness=
for i in "${!args[@]}"; do
  [[ ${args[$i]} == --harness ]] && harness=${args[$((i + 1))]:-}
done
if [[ $harness != stub && ${MAESTRO_DEMO_GO:-} != 1 ]]; then
  die "harness '${harness:-unset}' spends money; get the owner's go, then set MAESTRO_DEMO_GO=1"
fi

mkdir -p "$root"
cd "$repo"
exec bun packs/classics/acceptance/setup.ts "$task" "$root/$name" "${args[@]}"
