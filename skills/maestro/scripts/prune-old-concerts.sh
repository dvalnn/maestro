#!/bin/sh
# Prunes concerts that `maestro prune` keeps because their config snapshot is missing, unreadable or does not compose.
# A temporary bridge from v0.3.0: remove it after the next stable release.
#
# Usage: prune-old-concerts.sh [--yes] <concert-id>...   (full ids, as `maestro prune` prints them)
#
# It runs `maestro prune`, gives each concert that prune kept a snapshot of the code defaults, runs `maestro prune`
# again, then puts each earlier snapshot back on any concert still in the record. Needs `maestro` and `sqlite3`.

yes=0
ids=
for arg in "$@"; do
	case $arg in
	--yes) yes=1 ;;
	-*)
		printf '%s\n' "unknown flag '$arg'" >&2
		echo "Usage: prune-old-concerts.sh [--yes] <concert-id>..." >&2
		exit 2
		;;
	'' | *[!0-9a-f-]*)
		printf '%s\n' "'$arg' is not a concert id" >&2
		echo "Pass the full ids that 'maestro prune' printed" >&2
		exit 2
		;;
	*) ids="$ids $arg" ;;
	esac
done
if [ -z "$ids" ]; then
	echo "no concert ids given" >&2
	echo "Pass the full ids that 'maestro prune' printed when it kept a concert" >&2
	exit 2
fi

if [ "$yes" = 0 ]; then
	if [ ! -t 0 ]; then
		echo "this script deletes concerts, and there is no terminal to ask on" >&2
		echo "Pass --yes" >&2
		exit 2
	fi
	printf 'Prune%s? [y/N] ' "$ids" >&2
	read -r reply
	case $reply in
	y | Y | yes) ;;
	*)
		echo "nothing pruned" >&2
		exit 0
		;;
	esac
fi

# maestro resolves the data root once; the maestro calls below share its record store through XDG_DATA_HOME.
root=$(maestro --data-root) || exit 1
db=$root/record.db
# Parameter expansion, not dirname: command substitution would strip a trailing newline of the parent.
XDG_DATA_HOME=${root%/maestro}
# A root of /maestro has an empty parent, which maestro reads as unset.
XDG_DATA_HOME=${XDG_DATA_HOME:-/}
export XDG_DATA_HOME

work=$(mktemp -d) || exit 1
written=
trap 'finish' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Runs sqlite3 on the record, waiting up to ten seconds for another writer's lock.
record() { sqlite3 -cmd '.timeout 10000' "$db" "$1"; }

# Puts back the earlier snapshot of each concert written, where it is still in the record. A concert it cannot restore
# stays in $written, with its earlier snapshot in $work.
restore() {
	left=
	for id in $written; do
		record "UPDATE concerts SET snapshot = $(cat "$work/$id") WHERE id = '$id'" || left="$left $id"
	done
	written=$left
	if [ -n "$written" ]; then
		printf '%s\n' "could not restore the snapshot of concert$written in $db" >&2
		printf '%s\n' "Each holds {\"layers\":[]}; its earlier snapshot, as an SQL literal, is in $work/<concert>" >&2
		return 1
	fi
}

finish() {
	restore
	if [ -z "$written" ]; then rm -rf "$work"; fi
}

# Runs maestro prune on the given ids, showing its output, and leaves the ids it kept in $work/kept.
prune() {
	maestro prune "$@" --yes 2>"$work/err"
	code=$?
	cat "$work/err" >&2
	sed -n 's/^concert \([0-9a-f-]\{1,\}\) kept:.*/\1/p' "$work/err" >"$work/kept"
}

prune $ids
if [ "$code" = 0 ]; then exit 0; fi
if [ ! -s "$work/kept" ]; then exit "$code"; fi
kept=$(cat "$work/kept")

for id in $kept; do
	record "SELECT quote(snapshot) FROM concerts WHERE id = '$id' AND status != 'running'" >"$work/$id" || exit 1
	if [ -s "$work/$id" ]; then
		written="$written $id"
		record "UPDATE concerts SET snapshot = '{\"layers\":[]}' WHERE id = '$id'" || exit 1
	fi
done
if [ -z "$written" ]; then exit "$code"; fi

prune $written
retry=$code
restore || exit 1
exit "$retry"
