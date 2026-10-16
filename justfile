# format check, lint, typecheck, test
check:
    bunx biome check .
    bunx prettier --check "**/*.md"
    bunx tsc --noEmit
    bun test

# auto-format
fmt:
    bunx biome format --write .
    bunx prettier --write "**/*.md"
