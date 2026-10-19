# format check, lint, typecheck, test
check:
    bunx biome check .
    bun scripts/domain-words.ts
    bunx prettier --check "**/*.md"
    bunx tsc --noEmit
    bun test

# auto-format
fmt:
    bunx biome format --write .
    bunx prettier --write "**/*.md"

# build the release artifacts into dist/ and smoke-test them
release: check
    #!/usr/bin/env bash
    set -euo pipefail
    build=$(mktemp -d)
    trap 'rm -rf "$build"' EXIT
    rm -rf dist
    mkdir dist
    bun build --target=bun --format=esm packages/cli/src/embedded-sdk.ts --outfile "$build/embedded-sdk.js"
    bun build --target=bun --format=esm --external '@maestro/sdk*' packages/host-repo-sdk/src/index.ts \
      --outfile "$build/embedded-host-repo-sdk.js"
    bun build --compile --target=bun-linux-x64 --no-compile-autoload-bunfig --sourcemap \
      --asset "$build/embedded-sdk.js" --asset "$build/embedded-host-repo-sdk.js" \
      packages/cli/src/maestro.ts --outfile "$build/maestro"
    cp "$build/maestro" dist/maestro-linux-x64
    for package in ir sdk host-repo-sdk; do
      (cd "packages/$package" && bun pm pack --destination ../../dist --quiet >/dev/null)
    done
    (cd dist && sha256sum * > SHA256SUMS)
    scripts/smoke-install.sh dist
