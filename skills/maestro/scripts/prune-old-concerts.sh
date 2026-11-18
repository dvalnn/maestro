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
		echo "unknown flag '$arg'" >&2
		echo "Usage: prune-old-concerts.sh [--yes] <concert-id>..." >&2
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

# The data root as maestro resolves it: XDG_DATA_HOME when the shell sets it (maestro keeps it over the .env, and
# ignores it when relative), else the one in maestro's .env, else ~/.local/share.
absolute() { case $1 in /*) echo "$1" ;; esac; }
if [ -n "${XDG_DATA_HOME+set}" ]; then
	data=$(absolute "$XDG_DATA_HOME")
else
	config=$(absolute "${XDG_CONFIG_HOME:-}")
	config=${config:-${HOME:-~}/.config}
	data=
	if [ -f "$config/maestro/.env" ]; then
		# The last assignment wins; a quoted value ends at its closing quote, an unquoted one at ` #`.
		value=$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}XDG_DATA_HOME[[:space:]]*=[[:space:]]*//p' "$config/maestro/.env" |
			tail -n 1 | sed \
			-e "s/^\"\([^\"]*\)\".*/\1/;t" \
			-e "s/^'\([^']*\)'.*/\1/;t" \
			-e 's/^`\([^`]*\)`.*/\1/;t' \
			-e 's/#.*//' -e 's/[[:space:]]*$//')
		data=$(absolute "$value")
	fi
fi
XDG_DATA_HOME=${data:-${HOME:-~}/.local/share}
export XDG_DATA_HOME
db=$XDG_DATA_HOME/maestro/record.db

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
		echo "could not restore the snapshot of concert$written in $db" >&2
		echo "Each holds {\"layers\":[]}; its earlier snapshot, as an SQL literal, is in $work/<concert>" >&2
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
