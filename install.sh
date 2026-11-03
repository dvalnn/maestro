#!/bin/sh
# Installs or updates maestro from a forge release: the newest stable one, or with MAESTRO_CHANNEL=rc the newest one,
# pre-releases included. MAESTRO_VERSION=<tag> pins a release, MAESTRO_RELEASE_DIR=<dir> installs from a directory of
# release assets instead of the forge.
set -eu

FAILURE=1
INTERRUPTED=130
TERMINATED=143
FORGE=https://git.amorimcasa.org
REPO=tiago/maestro
REQUIRED_ASSETS="maestro-linux-x64 maestro-skill.tar.gz"

fail() {
  printf 'install.sh: error: %s\n' "$1" >&2
  [ $# -lt 2 ] || printf '%s\n' "$2" >&2
  exit "$FAILURE"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed" "Install $1 and run this again"
}

# Copies or downloads release asset $1 of release $tag into the current directory.
fetch() {
  if [ -n "${MAESTRO_RELEASE_DIR:-}" ]; then
    cp "$MAESTRO_RELEASE_DIR/$1" "$1" || fail "cannot read $MAESTRO_RELEASE_DIR/$1" "Check MAESTRO_RELEASE_DIR"
  else
    curl -fsL -o "$1" "$FORGE/$REPO/releases/download/$tag/$1" ||
      fail "cannot download $1 from release $tag" "Check the network and MAESTRO_VERSION"
  fi
}

# Prints the newest release tag on channel $1: stable skips pre-releases, rc takes the newest release of any kind.
latest_tag() {
  case $1 in
    stable) filter='&pre-release=false' ;;
    rc) filter= ;;
  esac
  curl -fsL "$FORGE/api/v1/repos/$REPO/releases?limit=1$filter" |
    sed -n 's/.*"tag_name":"\([^"]*\)".*/\1/p' | head -n 1
}

# Fetches every asset SHA256SUMS lists, then checks them against it.
fetch_assets() {
  fetch SHA256SUMS
  while read -r _ asset; do
    asset=${asset#\*}
    case $asset in
      */* | .*) fail "SHA256SUMS names '$asset', which is not a release asset" "Run this again, and report it if it persists" ;;
    esac
    fetch "$asset"
  done <SHA256SUMS
  for asset in $REQUIRED_ASSETS; do
    [ -f "$asset" ] || fail "SHA256SUMS does not list $asset" "Pin a release that has it with MAESTRO_VERSION=<tag>"
  done
  ls classics-*.tar.gz maestro-ir-[0-9]*.tgz maestro-sdk-[0-9]*.tgz maestro-host-repo-sdk-[0-9]*.tgz >/dev/null 2>&1 ||
    fail "SHA256SUMS does not list the classics pack or the sdk tarballs" "Pin a release that has them with MAESTRO_VERSION=<tag>"
  sha256sum -c --quiet SHA256SUMS >&2 || fail "the downloaded assets do not match SHA256SUMS" "Run this again, and report it if it persists"
}

# Fails when the installed maestro, if any, lists a running concert or cannot list concerts.
refuse_while_running() {
  [ -x "$bin_dir/maestro" ] || return 0
  status=0
  listing=$(cd "$start_dir" && "$bin_dir/maestro" ls --status running --json) || status=$?
  [ "$status" -eq 0 ] ||
    fail "cannot list concerts with $bin_dir/maestro" "Fix the error above, then run this again"
  running=$(printf '%s\n' "$listing" | sed -n 's/^ *"id": "\([^"]*\)".*/\1/p')
  [ -z "$running" ] && return 0
  if [ "$(printf '%s\n' "$running" | wc -l)" -eq 1 ]; then
    fail "concert $running is running" "Wait for it to settle, or maestro kill $running"
  fi
  fail "concerts $(printf '%s' "$running" | tr '\n' ' ')are running" "Wait for them to settle, or maestro kill <id>"
}

install_assets() {
  install -D -m 755 maestro-linux-x64 "$bin_dir/.maestro.new"
  mv -f "$bin_dir/.maestro.new" "$bin_dir/maestro"

  mkdir -p "$data_dir/packs" "$data_dir/sdk" "$skill_dir"
  rm -rf "$data_dir/packs/classics" "$skill_dir/maestro"
  tar -xzf classics-*.tar.gz -C "$data_dir/packs"
  tar -xzf maestro-skill.tar.gz -C "$skill_dir"
  rm -f "$data_dir"/sdk/maestro-*-[0-9]*.tgz
  for package in ir sdk host-repo-sdk; do
    cp maestro-"$package"-[0-9]*.tgz "$data_dir/sdk/maestro-$package.tgz"
  done
  # Releases before 0.1.0-beta.5 ship no classics package.
  for tgz in maestro-classics-[0-9]*.tgz; do
    [ ! -f "$tgz" ] || cp "$tgz" "$data_dir/sdk/maestro-classics.tgz"
  done
}

main() {
  bin_dir=$HOME/.local/bin
  skill_dir=$HOME/.claude/skills
  # A relative XDG_DATA_HOME is ignored, as maestro ignores it.
  case ${XDG_DATA_HOME:-} in
    /*) data_dir=$XDG_DATA_HOME/maestro ;;
    *) data_dir=$HOME/.local/share/maestro ;;
  esac

  channel=${MAESTRO_CHANNEL:-stable}
  case $channel in
    stable | rc) ;;
    *) fail "MAESTRO_CHANNEL is '$channel', which is not a channel" "Set MAESTRO_CHANNEL to stable or rc" ;;
  esac

  need sha256sum
  [ -n "${MAESTRO_RELEASE_DIR:-}" ] || need curl
  need tar
  need install

  start_dir=$PWD
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit $INTERRUPTED' INT
  trap 'exit $TERMINATED' TERM
  cd "$tmp"

  tag=${MAESTRO_VERSION:-}
  if [ -z "${MAESTRO_RELEASE_DIR:-}" ] && [ -z "$tag" ]; then
    tag=$(latest_tag "$channel") || tag=
    if [ -z "$tag" ]; then
      [ "$channel" = rc ] ||
        fail "cannot find a stable maestro release" "Check the network, or install the newest pre-release with MAESTRO_CHANNEL=rc"
      fail "cannot find the newest maestro release" "Check the network, or pin one with MAESTRO_VERSION=<tag>"
    fi
  fi

  fetch_assets
  refuse_while_running
  install_assets

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf 'install.sh: warning: %s is not on PATH\nAdd it to PATH in your shell profile\n' "$bin_dir" >&2 ;;
  esac

  "$bin_dir/maestro" --version
}

main "$@"
