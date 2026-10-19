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
release: check pack
    #!/usr/bin/env bash
    set -euo pipefail
    build=$(mktemp -d)
    trap 'rm -rf "$build"' EXIT
    rm -rf dist
    mkdir dist
    bun build --target=bun --format=esm packages/cli/src/embedded-sdk.ts --outfile "$build/embedded-sdk.js"
    bun build --target=bun --format=esm --external '@maestro/sdk*' packages/host-repo-sdk/src/index.ts \
      --outfile "$build/embedded-host-repo-sdk.js"
    bun build --compile --target=bun-linux-x64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig --sourcemap \
      --asset "$build/embedded-sdk.js" --asset "$build/embedded-host-repo-sdk.js" \
      packages/cli/src/maestro.ts --outfile "$build/maestro"
    cp "$build/maestro" dist/maestro-linux-x64
    for package in ir sdk host-repo-sdk; do
      (cd "packages/$package" && bun pm pack --destination ../../dist --quiet >/dev/null)
    done
    pack_version=$(bun -e 'console.log(require(process.argv[1]).version)' "$PWD/packs/classics/dist/maestro-pack.json")
    cp -r packs/classics/dist "$build/classics"
    tar -czf "dist/classics-$pack_version.tar.gz" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 \
      -C "$build" classics
    tar -czf dist/maestro-skill.tar.gz --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C skills maestro
    (cd dist && sha256sum * > SHA256SUMS)
    scripts/smoke-install.sh dist

# build a pack into its dist/
pack dir="packs/classics":
    bun scripts/pack.ts {{dir}}
