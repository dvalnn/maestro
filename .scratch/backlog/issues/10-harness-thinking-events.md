# Thinking as a harness event kind

Status: needs-triage

Owner ruling 2026-10-16: a host streams an agent's tool calls and thinking as progress events while the instance
executes (CORE-10, architecture 6.7), so `watch` keeps the predecessor's observability. The harness event union in
`packages/host-agents/src/harness/types.ts` has `tool` but no `thinking`. The adapter slice (S8d) adds it and maps pi's
thinking events to it; the agent host emits both through the execute context's `emit`.
