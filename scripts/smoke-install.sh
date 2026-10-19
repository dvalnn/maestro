#!/usr/bin/env bash
# Installs the release artifacts in <dist> into a scratch HOME as INSTALL.md says, and runs a stub composition with them.
set -euo pipefail

dist=$(realpath "${1:?usage: smoke-install.sh <dist>}")
version=$(bun -e 'console.log(require(process.argv[1]).version)' "$(dirname "$(realpath "$0")")/../packages/cli/package.json")
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

step "checksums"
(cd "$dist" && sha256sum -c SHA256SUMS >/dev/null)

step "install"
mkdir -p "$home" "$ws/.maestro"
install -D -m 755 "$dist/maestro-linux-x64" "$home/.local/bin/maestro"
if env -i PATH="$home/.local/bin:/usr/bin:/bin" sh -c 'command -v bun' >/dev/null; then
  fail "bun is on the smoke's PATH, so the binary is not shown standalone"
fi
line=$(maestro --version)
[[ $line =~ ^maestro\ $version\ \(sdk\ $version,\ ir\ [0-9]+\.[0-9]+,\ bun\ [0-9.]+\)$ ]] \
  || fail "maestro --version printed '$line'"

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
roles:
  smoke:
    harness: stub
    model: none
YAML
cat > "$ws/smoke.ts" <<'TS'
import { agent, check, fresh, read } from "@maestro/host-repo-sdk";
import { composition } from "@maestro/sdk";

export const smoke = composition("smoke", { examples: [{}] }, () => {
  const a = agent({ label: "a", task: "nothing", lane: fresh(), role: "smoke" });
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

step "IR file performs"
mkdir "$scratch/ir"
maestro compose smoke.ts --out "$scratch/ir/smoke.json" >/dev/null || fail "compose --out exited $?"
maestro perform "$scratch/ir/smoke.json" >/dev/null 2>"$scratch/perform.err" \
  || fail "perform smoke.json exited $?: $(cat "$scratch/perform.err")"

step "a file that does not bundle exits 2"
code=0
maestro compose broken.ts >/dev/null 2>&1 || code=$?
[ "$code" -eq 2 ] || fail "compose broken.ts exited $code, not 2"

step "package tarballs"
for package in ir sdk host-repo-sdk; do
  tgz=$dist/maestro-$package-$version.tgz
  ! tar -tzf "$tgz" | grep -q '\.test\.ts$' || fail "$tgz holds a test file"
  manifest=$(tar -xzOf "$tgz" package/package.json)
  grep -q '/fixtures/' <<<"$manifest" \
    || ! tar -tzf "$tgz" | grep -q '^package/\(src/\)\?fixtures/' || fail "$tgz holds fixtures its exports do not name"
  grep -q "\"version\": \"$version\"" <<<"$manifest" || fail "$tgz is not version $version"
  grep -q '"license": "UNLICENSED"' <<<"$manifest" || fail "$tgz is not UNLICENSED"
  ! grep -Eq '"@maestro/[a-z-]+": "(workspace:|\^|~)' <<<"$manifest" || fail "$tgz has an inexact @maestro dependency"
done

step "passed"
