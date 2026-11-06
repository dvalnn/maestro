# format check, lint, typecheck, test
check:
    bunx biome check .
    bun scripts/domain-words.ts
    bunx prettier --check "**/*.md"
    bunx tsc --noEmit
    bun test
    bun test ./.maestro

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
    gzip -9 -n -c "$build/maestro" > dist/maestro-linux-x64.gz
    for package in packages/ir packages/sdk packages/host-repo-sdk packs/classics; do
      (cd "$package" && bun pm pack --destination ../../dist --quiet >/dev/null)
    done
    pack_version=$(bun -e 'console.log(require(process.argv[1]).version)' "$PWD/packs/classics/dist/maestro-pack.json")
    cp -r packs/classics/dist "$build/classics"
    tar -czf "dist/classics-$pack_version.tar.gz" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 \
      -C "$build" classics
    tar -czf dist/maestro-skill.tar.gz --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C skills $(ls skills)
    sed -n 's/^\(pi\|claude\) = "\(.*\)"$/\1 \2/p' mise.toml > dist/harnesses
    [ "$(wc -l < dist/harnesses)" -eq 2 ] || { echo "mise.toml does not pin both pi and claude" >&2; exit 1; }
    (cd dist && sha256sum * > SHA256SUMS)
    cp install.sh dist/install.sh
    scripts/smoke-install.sh dist

# build a pack into its dist/
pack dir="packs/classics":
    bun scripts/pack.ts {{dir}}
