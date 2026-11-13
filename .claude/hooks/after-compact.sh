#!/bin/sh
# CLAUDE.md reloads after a compaction on its own. The harness cuts this output to a short preview, so it names what to
# read rather than printing it.
cd "$CLAUDE_PROJECT_DIR" || exit 0
echo "Context was compacted. Before acting, read, in this order:"
for f in .scratch/orchestrator-state.md .scratch/handoff.md; do
	[ -f "$f" ] && echo "- $f: where the work stands"
done
echo "- the active slice brief under .scratch/briefs/, if the work has one"
echo "- docs/agents/implementation-loop.md: the loop and the Owner calls rule"
exit 0
