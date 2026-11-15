# the tests run in parallel, unless TEST_SERIAL is set: CI's smaller runner times out subprocess tests under load
parallel := if env("TEST_SERIAL", "") == "" { "--parallel" } else { "" }

# format, fix lints, typecheck, test, in that order
check: fmt lint types test

# run check, then fail if it changed a tracked file or added an untracked one
ci: check
    #!/usr/bin/env bash
    set -euo pipefail
    changed=$(git status --porcelain --untracked-files=all)
    if [ -n "$changed" ]; then
      echo "just check changed these files; run just check and commit the result:" >&2
      echo "$changed" >&2
      exit 1
    fi

# apply Biome's safe lint fixes and import sorting without formatting, then check the domain words and prompt imports
lint:
    bunx biome check --write --formatter-enabled=false .
    bun scripts/domain-words.ts
    bun scripts/prompt-imports.ts

# typecheck
types:
    bunx tsc --noEmit

# run every test
test:
    bun test {{parallel}} --only-failures
    bun test {{parallel}} --only-failures ./.maestro

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
    bun build --target=bun --format=esm packages/host-repo-sdk/src/yaml.ts --outfile "$build/embedded-host-repo-sdk-yaml.js"
    bun build --compile --target=bun-linux-x64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig --sourcemap \
      --asset "$build/embedded-sdk.js" --asset "$build/embedded-host-repo-sdk.js" --asset "$build/embedded-host-repo-sdk-yaml.js" \
      packages/cli/src/maestro.ts --outfile "$build/maestro"
    gzip -9 -n -c "$build/maestro" > dist/maestro-linux-x64.gz
    for package in packages/ir packages/sdk packages/host-repo-sdk packs/classics; do
      (cd "$package" && cp ../../LICENSE . && trap 'rm -f LICENSE' EXIT && bun pm pack --destination ../../dist --quiet >/dev/null)
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

# add a jj workspace on main at ../maestro-<name>, its dependencies installed
ws name:
    jj workspace add ../maestro-{{name}} -r main
    cd ../maestro-{{name}} && bun install --frozen-lockfile

# forget the workspace `ws` added and delete its directory
ws-rm name:
    jj workspace forget maestro-{{name}}
    rm -rf ../maestro-{{name}}

# build a pack into its dist/
pack dir="packs/classics":
    bun scripts/pack.ts {{dir}}
