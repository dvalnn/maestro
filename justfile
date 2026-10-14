# format check, lint, typecheck, test
check:
    bunx biome check .
    bunx tsc --noEmit
    bun test

# auto-format
fmt:
    bunx biome format --write .
