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

# apply Biome's safe lint fixes and import sorting without formatting, lower the Plain English baseline, then check the domain words, prompt imports and Plain English limits,
# that no echo of a variable is left in a #!/bin/sh script (print it with printf '%s\n'),
# and that no git conflict marker of a merge onto main is left in (factory.md, Rules, Build: Encore)
lint:
    bunx biome check --write --formatter-enabled=false --error-on-warnings .
    bun scripts/domain-words.ts
    bun scripts/prompt-imports.ts
    bun scripts/plain-english.ts --update
    bun scripts/plain-english.ts
    ! grep -rnIE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.jj '^(<{7,}|>{7,}) [0-9a-f]{40}' .
    ! grep -rlZ --include='*.sh' --exclude-dir=node_modules --exclude-dir=.git '^#!/bin/sh' . | xargs -0 -r grep -nE '^[[:space:]]*echo\b[^#]*\$'

# typecheck
types:
    bunx tsc --noEmit

# run every test, or only the given test files (paths from the repository root)
[positional-arguments]
test *paths:
    #!/usr/bin/env bash
    set -euo pipefail
    targets=()
    for path in "$@"; do
      case "$path" in
        /* | ./*) targets+=("$path") ;;
        -*)
          echo "just test takes test file paths, not flags; run bun test <file> -t <pattern> to pick tests by name" >&2
          exit 2
          ;;
        *) targets+=("./$path") ;;
      esac
    done
    [ "${#targets[@]}" -gt 0 ] || targets=(./ ./.maestro)
    exec bun test {{parallel}} --timeout 30000 --only-failures "${targets[@]}"

# rewrite the transcripts from what the code prints now, after an intended change: all, or those of the given test files
[positional-arguments]
transcripts *paths:
    TRANSCRIPTS=write just test "$@"

# draw the transcripts as PNGs in <out>; with a base revision, only the sections that differ from it, before beside after
[positional-arguments]
pictures out base="":
    bun packages/transcript/src/pictures.ts "$@"

# sort the tests this tree adds or edits by what they guard, as <out>/guards.json: red, unloaded or green on <base>'s source
[positional-arguments]
guards out base:
    bun scripts/guards.ts "$@"

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

# run this checkout's maestro CLI in the current folder
[no-cd, positional-arguments]
maestro *args:
    bun "{{justfile_directory()}}/packages/cli/src/maestro.ts" "$@"

# in empty temp XDG folders, perform a stub concert of hello.ts, with the classics pack listed, then run maestro with the given command in the current folder
[no-cd, positional-arguments]
maestro-stub *args:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{justfile_directory()}}"
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    mkdir -p "$work/data" "$work/config/maestro/presets" "$work/fixtures"
    export XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config"
    cp "$root/.maestro/presets/stub.yaml" "$work/config/maestro/presets/"
    bun "$root/scripts/pack.ts" "$root/packs/classics" >/dev/null
    printf 'packs: [%s]\n' "$root/packs/classics/dist" > "$work/config/maestro/config.yaml"
    cp -r "$root/packages/cli/src/fixtures/hello.ts" "$root/packages/cli/src/fixtures/demo" "$work/fixtures/"
    (cd "$work/fixtures" && bun "$root/packages/cli/src/maestro.ts" perform hello.ts --preset stub >/dev/null)
    bun "$root/packages/cli/src/maestro.ts" "$@"

# build a pack into its dist/
pack dir="packs/classics":
    bun scripts/pack.ts {{dir}}
