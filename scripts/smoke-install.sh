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
mkdir -p "$home" "$ws/.maestro/profiles"
install -D -m 755 "$dist/maestro-linux-x64" "$home/.local/bin/maestro"
if env -i PATH="$home/.local/bin:/usr/bin:/bin" sh -c 'command -v bun' >/dev/null; then
  fail "bun is on the smoke's PATH, so the binary is not shown standalone"
fi
line=$(maestro --version)
[[ $line =~ ^maestro\ $version\ \(sdk\ $version,\ ir\ [0-9]+\.[0-9]+,\ bun\ [0-9.]+\)$ ]] \
  || fail "maestro --version printed '$line'"

step "pack and skill"
mkdir -p "$home/.local/share/maestro/packs" "$home/.claude/skills"
tar -xzf "$dist"/classics-*.tar.gz -C "$home/.local/share/maestro/packs"
tar -xzf "$dist/maestro-skill.tar.gz" -C "$home/.claude/skills"
pack=$home/.local/share/maestro/packs/classics
for file in "$pack/maestro-pack.json" "$pack/README.md" "$home/.claude/skills/maestro/SKILL.md"; do
  [ -f "$file" ] || fail "the tarballs did not install $file"
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
roles:
  smoke:
    harness: stub
    model: none
YAML
mkdir -p "$home/.config/maestro"
cat > "$home/.config/maestro/config.yaml" <<YAML
roles:
  scout: { harness: claude, model: sonnet, thinking: high }
  planner: { harness: claude, model: sonnet, thinking: high }
  builder: { harness: claude, model: sonnet, thinking: high }
  reviewer: { harness: claude, model: sonnet, thinking: high }
  skeptic: { harness: pi, model: openai/gpt-model-id, thinking: high }
  documenter: { harness: claude, model: sonnet, thinking: high }
YAML
cat > "$ws/.maestro/profiles/stub.yaml" <<YAML
roles:
  scout: !replace { harness: stub, model: none }
  planner: !replace { harness: stub, model: none }
  builder: !replace { harness: stub, model: none }
  reviewer: !replace { harness: stub, model: none }
  skeptic: !replace { harness: stub, model: none }
  documenter: !replace { harness: stub, model: none }
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

step "pack composes and performs"
maestro compose classics.build_then_repair --request smoke >/dev/null || fail "compose classics.build_then_repair exited $?"
maestro compose classics.panel_review --request smoke --change "$id.1" >/dev/null || fail "compose classics.panel_review exited $?"
maestro compose classics.v_model >/dev/null || fail "compose classics.v_model exited $?"
maestro perform classics.build_then_repair --request smoke --profile stub >/dev/null 2>"$scratch/perform.err" \
  || fail "perform classics.build_then_repair exited $?: $(cat "$scratch/perform.err")"
grep -q '^concert .* ok$' "$scratch/perform.err" || fail "build_then_repair did not settle ok: $(cat "$scratch/perform.err")"
[ -z "$(git -C "$target" status --porcelain)" ] || fail "the target checkout changed"
[ "$(git -C "$target" rev-parse HEAD)" = "$head" ] || fail "the target HEAD moved"

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
