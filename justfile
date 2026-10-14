# format check, lint, typecheck, test
check:
    bunx biome format .
    bunx biome lint .
    bunx tsc --noEmit
    bun test

# auto-format
fmt:
    bunx biome format --write .
