#!/bin/sh
# CLAUDE.md reloads after a compaction on its own. The loop and the owner rulings do not, so they are re-injected here.
cd "$CLAUDE_PROJECT_DIR" || exit 0
echo "Context was compacted. These are the working agreements in force; re-read the active slice brief before acting."
for f in docs/agents/implementation-loop.md .scratch/handoff.md; do
	[ -f "$f" ] && printf '\n--- %s ---\n\n' "$f" && cat "$f"
done
exit 0
