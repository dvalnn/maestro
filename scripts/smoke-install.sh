#!/usr/bin/env bash
# Installs the release artifacts in <dist> into a scratch HOME with install.sh, and runs a stub composition with them.
set -euo pipefail

dist=$(realpath "${1:?usage: smoke-install.sh <dist>}")
version=$(bun -e 'console.log(require(process.argv[1]).version)' "$(dirname "$(realpath "$0")")/../packages/cli/package.json")
installer=$(dirname "$(realpath "$0")")/../install.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
home=$scratch/home
target=$scratch/target
ws=$scratch/ws

step() { printf 'smoke: %s\n' "$*"; }
fail() { printf 'smoke: FAIL: %s\n' "$*" >&2; exit 1; }

# No XDG overrides, no Bun, no harness on PATH, and no network.
maestro() {
  env -i HOME="$home" PATH="$home/.local/bin:/usr/bin:/bin" unshare -rn maestro "$@"
}

# Runs install.sh from stdin, as `curl | sh` does, into HOME $1 from the release directory $2, with the shell $3.
run_installer() {
  env -i HOME="$1" PATH="/usr/bin:/bin" MAESTRO_RELEASE_DIR="$2" "${3:-sh}" < "$installer"
}

step "install.sh"
mkdir -p "$ws/.maestro/presets"
run_installer "$home" "$dist" >"$scratch/install.out" 2>"$scratch/install.err" \
  || fail "install.sh exited $?: $(cat "$scratch/install.err")"
grep -q "^install.sh: warning: $home/.local/bin is not on PATH" "$scratch/install.err" || fail "install.sh did not warn about PATH"
grep -q '^maestro ' "$scratch/install.out" || fail "install.sh did not print the version on stdout"

step "install.sh warns of a harness at another version, and logs what it ran"
mkdir -p "$scratch/fakes"
printf '#!/bin/sh\necho 0.0.1\n' > "$scratch/fakes/pi"
chmod +x "$scratch/fakes/pi"
pin=$(sed -n 's/^pi //p' "$dist/harnesses")
env -i HOME="$scratch/pi-home" PATH="$scratch/fakes:/usr/bin:/bin" MAESTRO_RELEASE_DIR="$dist" sh < "$installer" \
  >/dev/null 2>"$scratch/install.err" || fail "install.sh exited $?: $(cat "$scratch/install.err")"
grep -q "pi is 0.0.1, and this maestro supports pi $pin" "$scratch/install.err" || fail "install.sh did not warn about pi 0.0.1"
grep -q "mise use -g pi@$pin" "$scratch/install.err" || fail "install.sh did not give the mise pin"
grep -q 'install -D -m 755' "$scratch/pi-home/.local/state/maestro/install.log" || fail "install.sh did not log what it ran"

step "install.sh replaces stale files"
skills=$(tar -tzf "$dist/maestro-skill.tar.gz" | sed 's,/.*,,' | sort -u)
mkdir -p "$home/.local/share/maestro/packs/classics"
touch "$home/.local/share/maestro/packs/classics/stale" \
  "$home/.local/share/maestro/sdk/maestro-ir-0.0.0.tgz" "$home/.local/share/maestro/sdk/maestro-host-repo-sdk-0.0.0.tgz"
for root in "$home/.claude/skills" "$home/.agents/skills"; do
  mkdir -p "$root/mine"
  touch "$root/mine/SKILL.md"
  for skill in $skills; do
    mkdir -p "$root/$skill"
    touch "$root/$skill/stale"
  done
done
run_installer "$home" "$dist" >/dev/null 2>"$scratch/install.err" \
  || fail "install.sh over an install exited $?: $(cat "$scratch/install.err")"
for root in "$home/.claude/skills" "$home/.agents/skills"; do
  [ -f "$root/mine/SKILL.md" ] || fail "install.sh removed $root/mine, a skill not in the release"
  for skill in $skills; do
    [ ! -e "$root/$skill/stale" ] || fail "install.sh left a stale file in $root/$skill"
  done
done
[ ! -e "$home/.local/share/maestro/packs/classics/stale" ] || fail "install.sh left a stale pack file"
for old in maestro-ir-0.0.0.tgz maestro-host-repo-sdk-0.0.0.tgz; do
  [ ! -e "$home/.local/share/maestro/sdk/$old" ] || fail "install.sh left the old sdk tarball $old"
done

step "install.sh installs nothing from a corrupted asset"
cp -r "$dist" "$scratch/bad"
printf x >> "$scratch/bad/maestro-skill.tar.gz"
code=0
run_installer "$scratch/bad-home" "$scratch/bad" >/dev/null 2>"$scratch/install.err" || code=$?
[ "$code" -ne 0 ] || fail "install.sh accepted a corrupted asset"
grep -q 'FAILED' "$scratch/install.err" || fail "install.sh hid the failed checksum: $(cat "$scratch/install.err")"
[ ! -e "$scratch/bad-home/.local" ] || fail "install.sh installed from a corrupted release"
[ ! -e "$scratch/bad-home/.agents" ] || fail "install.sh installed a skill from a corrupted release"

if command -v dash >/dev/null; then
  step "install.sh under dash"
  run_installer "$scratch/dash-home" "$dist" dash >/dev/null 2>"$scratch/install.err" \
    || fail "install.sh under dash exited $?: $(cat "$scratch/install.err")"
fi

for package in ir sdk host-repo-sdk classics; do
  [ -f "$home/.local/share/maestro/sdk/maestro-$package.tgz" ] || fail "install.sh did not install the $package tarball"
done
if env -i PATH="$home/.local/bin:/usr/bin:/bin" sh -c 'command -v bun' >/dev/null; then
  fail "bun is on the smoke's PATH, so the binary is not shown standalone"
fi
line=$(maestro --version)
[[ $line =~ ^maestro\ $version\ \(sdk\ $version,\ ir\ [0-9]+\.[0-9]+,\ bun\ [0-9.]+\)$ ]] \
  || fail "maestro --version printed '$line'"

step "pack and skill"
pack=$home/.local/share/maestro/packs/classics
for file in "$pack/maestro-pack.json" "$pack/README.md" "$pack/profiles/builder/profile.yaml"; do
  [ -f "$file" ] || fail "the tarballs did not install $file"
done
for skill in maestro maestro-ultracode; do
  for root in "$home/.claude/skills" "$home/.agents/skills"; do
    [ -f "$root/$skill/SKILL.md" ] || fail "the tarballs did not install $root/$skill/SKILL.md"
  done
done
pack_version=$(bun -e 'console.log(require(process.argv[1]).version)' "$pack/maestro-pack.json")
[ -f "$dist/classics-$pack_version.tar.gz" ] || fail "no classics tarball is named for the manifest's version $pack_version"
pack_id=$(bun -e 'console.log(require(process.argv[1]).id)' "$pack/maestro-pack.json")

step "extracting the pack installs it, with no packs in config"
grep -q "\"path\": \"$pack\"" <<<"$(maestro rep --json)" || fail "rep --json does not list $pack"
maestro rep "$pack_id" >/dev/null || fail "rep $pack_id exited $?"

step "the .env beside the user config is loaded, and one in the cwd is not"
alt=$scratch/alt
mkdir -p "$alt/maestro/packs" "$home/.config/maestro"
cp -r "$pack" "$alt/maestro/packs/$pack_id"
printf 'XDG_DATA_HOME=%s\n' "$alt" > "$ws/.env"
grep -q "\"path\": \"$pack\"" <<<"$(cd "$ws" && maestro rep --json)" || fail "the binary loaded the cwd's .env"
rm "$ws/.env"
printf 'XDG_DATA_HOME=%s\n' "$alt" > "$home/.config/maestro/.env"
grep -q "\"path\": \"$alt/maestro/packs/$pack_id\"" <<<"$(maestro rep --json)" \
  || fail "the binary did not load ~/.config/maestro/.env"
rm "$home/.config/maestro/.env"

step "toy target"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=op GIT_AUTHOR_EMAIL=op@x \
  GIT_COMMITTER_NAME=op GIT_COMMITTER_EMAIL=op@x
git init -q -b main "$target"
git -C "$target" commit -q --allow-empty -m one
head=$(git -C "$target" rev-parse HEAD)
cat > "$ws/.maestro/config.yaml" <<YAML
target:
  repo: $target
  base: main
  checks:
    smoke: "true"
YAML
mkdir -p "$ws/.maestro/profiles/smoke"
cat > "$ws/.maestro/profiles/smoke/profile.yaml" <<YAML
runtime: { harness: stub, model: none }
YAML
mkdir -p "$home/.config/maestro"
cat > "$home/.config/maestro/config.yaml" <<YAML
profiles:
  classics/scout: { runtime: { harness: claude, model: sonnet, thinking: high } }
  classics/planner: { runtime: { harness: claude, model: sonnet, thinking: high } }
  classics/builder: { runtime: { harness: claude, model: sonnet, thinking: high } }
  classics/lens: { runtime: { harness: claude, model: sonnet, thinking: high } }
  classics/consolidator: { runtime: { harness: claude, model: sonnet, thinking: high } }
  classics/skeptic: { runtime: { harness: pi, model: openai/gpt-model-id, thinking: high } }
YAML
cat > "$ws/.maestro/presets/stub.yaml" <<'YAML'
profiles:
  "*": { runtime: !replace { harness: stub } }
YAML
cat > "$ws/smoke.ts" <<'TS'
import { check, fresh, read, seat } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const smoke = composition("smoke", { examples: [{}] }, () => {
  const a = seat("smoke")({ label: "a", task: "nothing", lane: fresh() });
  return check(read(a.out.lane), "smoke", { label: "check" });
});
TS
printf 'export const broken = ;\n' > "$ws/broken.ts"

step "bare file composes and performs"
cd "$ws"
maestro compose smoke.ts >/dev/null || fail "compose smoke.ts exited $?"
maestro perform smoke.ts >/dev/null 2>"$scratch/perform.err" || fail "perform smoke.ts exited $?: $(cat "$scratch/perform.err")"
id=$(sed -n 's/^concert \([^ ]*\)$/\1/p' "$scratch/perform.err")
[ -n "$id" ] || fail "perform printed no concert id"
listing=$(maestro ls "$id" --json)
for node in a check; do
  grep -A2 "\"node\": \"$node\"" <<<"$listing" | grep -q '"status": "ok"' || fail "ls $id does not show node '$node' ok"
done
[ -z "$(git -C "$target" status --porcelain)" ] || fail "the target checkout changed"
[ "$(git -C "$target" rev-parse HEAD)" = "$head" ] || fail "the target HEAD moved"

step "a Markdown text import reaches the IR"
printf 'Markdown prompt marker.\n' > "$ws/texted.md"
cat > "$ws/texted.ts" <<'TS'
import { check, fresh, read, seat } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";
import TEXT from "./texted.md" with { type: "text" };

export const texted = composition("texted", { examples: [{}] }, () => {
  const a = seat("smoke")({ label: "a", task: TEXT, lane: fresh() });
  return check(read(a.out.lane), "smoke", { label: "check" });
});
TS
grep -q "Markdown prompt marker." <<<"$(maestro compose texted.ts --json)" || fail "compose texted.ts did not carry the .md text"

step "IR file performs"
mkdir "$scratch/ir"
maestro compose smoke.ts --out "$scratch/ir/smoke.json" >/dev/null || fail "compose --out exited $?"
maestro perform "$scratch/ir/smoke.json" >/dev/null 2>"$scratch/perform.err" \
  || fail "perform smoke.json exited $?: $(cat "$scratch/perform.err")"

step "a file that does not bundle exits 1"
code=0
maestro compose broken.ts >/dev/null 2>&1 || code=$?
[ "$code" -eq 1 ] || fail "compose broken.ts exited $code, not 1"

step "pack composes and performs"
maestro compose classics.build_then_repair --request smoke >/dev/null || fail "compose classics.build_then_repair exited $?"
maestro compose classics.panel_review --request smoke --change "$id.1" >/dev/null || fail "compose classics.panel_review exited $?"
maestro perform classics.build_then_repair --request smoke --preset stub >/dev/null 2>"$scratch/perform.err" \
  || fail "perform classics.build_then_repair exited $?: $(cat "$scratch/perform.err")"
grep -qE '^concert +[k-z]+ +ok( |$)' "$scratch/perform.err" || fail "build_then_repair did not settle ok: $(cat "$scratch/perform.err")"
[ -z "$(git -C "$target" status --porcelain)" ] || fail "the target checkout changed"
[ "$(git -C "$target" rev-parse HEAD)" = "$head" ] || fail "the target HEAD moved"

step "install.sh refuses while a concert runs"
slow() {
  env -i HOME="$home" PATH="$home/.local/bin:/usr/bin:/bin" MAESTRO_STUB_DELAY=60s unshare -rn maestro "$@"
}
slow perform smoke.ts >/dev/null 2>"$scratch/slow.err" &
slow_pid=$!
slow_id=
for _ in $(seq 100); do
  slow_id=$(sed -n 's/^concert \([^ ]*\)$/\1/p' "$scratch/slow.err")
  [ -n "$slow_id" ] && grep -q '"status": "running"' <<<"$(maestro ls --status running --json)" && break
  sleep 0.1
done
[ -n "$slow_id" ] || fail "the slow concert did not start: $(cat "$scratch/slow.err")"
code=0
run_installer "$home" "$dist" >/dev/null 2>"$scratch/install.err" || code=$?
maestro kill "$slow_id" >/dev/null 2>&1 || true
wait "$slow_pid" || true
[ "$code" -ne 0 ] || fail "install.sh installed over a running concert"
grep -q "concert $slow_id is running" "$scratch/install.err" || fail "install.sh did not name the running concert: $(cat "$scratch/install.err")"
grep -q "maestro kill $slow_id" "$scratch/install.err" || fail "install.sh did not hint maestro kill $slow_id"

step "package tarballs"
for package in ir sdk host-repo-sdk classics; do
  tgz=$dist/maestro-$package-$version.tgz
  ! tar -tzf "$tgz" | grep -q '\.test\.ts$' || fail "$tgz holds a test file"
  manifest=$(tar -xzOf "$tgz" package/package.json)
  grep -q '/fixtures/' <<<"$manifest" \
    || ! tar -tzf "$tgz" | grep -q '^package/\(src/\)\?fixtures/' || fail "$tgz holds fixtures its exports do not name"
  grep -q "\"version\": \"$version\"" <<<"$manifest" || fail "$tgz is not version $version"
  grep -q '"license": "MIT"' <<<"$manifest" || fail "$tgz is not MIT-licensed"
  ! grep -Eq '"@maestro/[a-z-]+": "(workspace:|\^|~)' <<<"$manifest" || fail "$tgz has an inexact @maestro dependency"
done

step "a composition builds on the classics package"
author=$ws/author
mkdir -p "$author"
sdk=$home/.local/share/maestro/sdk
deps=$(for package in ir sdk host-repo-sdk classics; do printf '"@maestro/%s": "file:%s/maestro-%s.tgz",' "$package" "$sdk" "$package"; done)
printf '{"dependencies": {%s}, "overrides": {%s}}\n' "${deps%,}" "${deps%,}" > "$author/package.json"
(cd "$author" && bun install --silent) || fail "bun install of the package tarballs exited $?"
cat > "$author/flow.ts" <<'TS'
import { builder } from "@maestro/classics";
import { fresh } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const flow = composition("flow", { examples: [{}] }, () =>
  builder({ label: "build", task: "nothing", lane: fresh() }),
);
TS
maestro compose author/flow.ts --preset stub >/dev/null || fail "compose of a file importing @maestro/classics exited $?"

step "passed"
