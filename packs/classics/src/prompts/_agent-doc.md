Files written for coding agents, such as `AGENTS.md`, `CLAUDE.md` and `SKILL.md`, on every added or changed line.

1. Every line changes what an agent would do by default; greetings, exhortations, emphasis and capitals change nothing
   and go.
2. Each instruction states the target behaviour, concrete and checkable, rather than a bare prohibition or a vague "be
   good".
3. The file holds what an agent cannot find by looking; what the manifest, the config or the directory layout already
   says is left to them.
4. Each instruction agrees with the repo as it stands: its code and tests, its docs, and the file's own other lines.
