# A lane can read other lanes' sealed versions

Status: needs-triage

Owner ruling 2026-10-14: accepted as a known V1 gap (ADR 0005, "What an agent can discover").

`git cat-file --batch-all-objects`, or a listing of the store's objects directory, lets an agent read objects that no
visible ref names: other lanes' and other concerts' versions, and target commits fetched for other bases.

Candidate fix: give each lane only its own objects, for example a per-lane object directory with the base reachable
through alternates. Cost: more lane setup work and slower forks.
