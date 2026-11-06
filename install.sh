#!/bin/sh
# Installs or updates maestro from a forge release: the newest stable one, or with MAESTRO_CHANNEL=rc the newest one,
# pre-releases included. MAESTRO_VERSION=<tag> pins a release, MAESTRO_RELEASE_DIR=<dir> installs from a directory of
# release assets instead of the forge. Every command that changes the machine is appended to install.log in
# $XDG_STATE_HOME/maestro.
set -eu

FAILURE=1
INTERRUPTED=130
TERMINATED=143
FORGE=https://git.amorimcasa.org
REPO=tiago/maestro
REQUIRED_ASSETS="maestro-skill.tar.gz"
# The binary, gzipped since 0.1.0-rc.5 to fit the forge's upload limit; a release before ships it as it is.
BINARY=maestro-linux-x64
# The harness versions a release supports, one `<tool> <version>` per line; releases before 0.1.0 ship none.
HARNESSES=harnesses
MIN_GIT=2.40
MISE_URL=https://mise.jdx.dev/getting-started.html

fail() {
  printf 'install.sh: error: %s\n' "$1" >&2
  [ $# -lt 2 ] || printf '%s\n' "$2" >&2
  exit "$FAILURE"
}

say() {
  printf 'install.sh: %s\n' "$1" >&2
}

warn() {
  printf 'install.sh: warning: %s\n%s\n' "$1" "$2" >&2
}

# Appends command $@ to the install log, then runs it.
run() {
  mkdir -p "${log_file%/*}"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log_file"
  "$@"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed" "Install $1 and run this again"
}

# Copies or downloads release asset $1 of release $tag into the current directory.
fetch() {
  if [ -n "${MAESTRO_RELEASE_DIR:-}" ]; then
    cp "$MAESTRO_RELEASE_DIR/$1" "$1" || fail "cannot read $MAESTRO_RELEASE_DIR/$1" "Check MAESTRO_RELEASE_DIR"
  else
    say "downloading $1"
    curl -fL "$progress" -o "$1" "$FORGE/$REPO/releases/download/$tag/$1" ||
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
  [ -f "$BINARY.gz" ] || [ -f "$BINARY" ] ||
    fail "SHA256SUMS does not list $BINARY.gz" "Pin a release that has it with MAESTRO_VERSION=<tag>"
  ls classics-*.tar.gz maestro-ir-[0-9]*.tgz maestro-sdk-[0-9]*.tgz maestro-host-repo-sdk-[0-9]*.tgz >/dev/null 2>&1 ||
    fail "SHA256SUMS does not list the classics pack or the sdk tarballs" "Pin a release that has them with MAESTRO_VERSION=<tag>"
  say "verifying checksums"
  sha256sum -c --quiet SHA256SUMS >&2 || fail "the downloaded assets do not match SHA256SUMS" "Run this again, and report it if it persists"
  [ ! -f "$BINARY.gz" ] || gzip -dc "$BINARY.gz" >"$BINARY" ||
    fail "cannot unpack $BINARY.gz" "Run this again, and report it if it persists"
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
  say "installing into $bin_dir and $data_dir"
  run install -D -m 755 "$BINARY" "$bin_dir/.maestro.new"
  run mv -f "$bin_dir/.maestro.new" "$bin_dir/maestro"

  run mkdir -p "$data_dir/packs" "$data_dir/sdk"
  run rm -rf "$data_dir/packs/classics"
  run tar -xzf classics-*.tar.gz -C "$data_dir/packs"
  # Codex and pi both read user skills from ~/.agents/skills.
  skills=$(tar -tzf maestro-skill.tar.gz | sed -e 's,^\./,,' -e 's,/.*,,' | sort -u)
  [ -n "$skills" ] || fail "maestro-skill.tar.gz lists no skill" "Download the release again"
  for skill_dir in "$claude_skills" "$agents_skills"; do
    run mkdir -p "$skill_dir"
    for skill in $skills; do
      case $skill in .|..) continue ;; esac
      run rm -rf "${skill_dir:?}/$skill"
    done
    run tar -xzf maestro-skill.tar.gz -C "$skill_dir"
  done
  run rm -f "$data_dir"/sdk/maestro-*-[0-9]*.tgz
  for package in ir sdk host-repo-sdk; do
    run cp maestro-"$package"-[0-9]*.tgz "$data_dir/sdk/maestro-$package.tgz"
  done
  # Releases before 0.1.0-beta.5 ship no classics package.
  for tgz in maestro-classics-[0-9]*.tgz; do
    [ ! -f "$tgz" ] || run cp "$tgz" "$data_dir/sdk/maestro-classics.tgz"
  done
}

# Warns about each tool maestro runs on that is missing or too old; none of them stops the install.
check_requirements() {
  command -v bwrap >/dev/null 2>&1 || warn "bwrap is not installed" "Install bubblewrap; every agent runs under it"
  [ -x /bin/bash ] || warn "/bin/bash is missing" "Install bash; every sandbox runs under it"
  if ! command -v git >/dev/null 2>&1; then
    warn "git is not installed" "Install git $MIN_GIT or newer"
    return 0
  fi
  git_version=$(git --version | cut -d' ' -f3)
  [ "$(printf '%s\n%s\n' "$MIN_GIT" "$git_version" | sort -V | head -n 1)" = "$MIN_GIT" ] ||
    warn "git is $git_version" "Install git $MIN_GIT or newer"
}

# Prints the version of harness $1 as the target directory resolves it, or nothing when it is not installed.
harness_version() {
  (cd "$start_dir" && "$1" --version 2>/dev/null) | head -n 1 | cut -d' ' -f1
}

# Prints `<tool>@<version>` for each installed harness at another version than the release supports.
stale_harnesses() {
  while read -r tool version; do
    have=$(harness_version "$tool")
    [ -z "$have" ] || [ "$have" = "$version" ] || printf ' %s@%s' "$tool" "$version"
  done <"$HARNESSES"
}

# Asks yes or no on the terminal; no without one.
confirm() {
  [ -t 2 ] && (: </dev/tty) 2>/dev/null || return 1
  printf 'install.sh: %s [y/N] ' "$1" >&2
  read -r answer </dev/tty || return 1
  case $answer in [yY]*) return 0 ;; *) return 1 ;; esac
}

# Warns about harnesses at another version than the release supports, and offers to pin them with mise.
check_harnesses() {
  [ -f "$HARNESSES" ] || return 0
  say "checking harnesses"
  installed=
  while read -r tool version; do
    have=$(harness_version "$tool")
    [ -z "$have" ] || installed=1
    [ -z "$have" ] || [ "$have" = "$version" ] ||
      warn "$tool is $have, and this maestro supports $tool $version" "maestro may misread its runs; pin $tool $version"
  done <"$HARNESSES"
  [ -n "$installed" ] ||
    warn "no harness is installed" "Install one with mise: mise use -g $(head -n 1 "$HARNESSES" | tr ' ' '@')"
  stale=$(stale_harnesses)
  [ -n "$stale" ] || return 0
  if ! command -v mise >/dev/null 2>&1; then
    say "mise pins harness versions per user and per project: $MISE_URL"
    say "with mise installed, run: mise use -g$stale"
    return 0
  fi
  if ! confirm "pin$stale globally with mise?"; then
    say "to pin them, run: mise use -g$stale"
    return 0
  fi
  # shellcheck disable=SC2086 # one tool@version per word
  run mise use -g $stale >&2 || fail "mise use -g$stale failed" "Fix the error above, then run it again"
  stale=$(stale_harnesses)
  [ -z "$stale" ] || warn "the pin does not take effect in $start_dir for:$stale" \
    "Put mise's shims first on PATH, or check the mise.toml in $start_dir"
}

main() {
  bin_dir=$HOME/.local/bin
  claude_skills=$HOME/.claude/skills
  agents_skills=$HOME/.agents/skills
  # A relative XDG_DATA_HOME is ignored, as maestro ignores it.
  case ${XDG_DATA_HOME:-} in
    /*) data_dir=$XDG_DATA_HOME/maestro ;;
    *) data_dir=$HOME/.local/share/maestro ;;
  esac
  case ${XDG_STATE_HOME:-} in
    /*) log_file=$XDG_STATE_HOME/maestro/install.log ;;
    *) log_file=$HOME/.local/state/maestro/install.log ;;
  esac
  progress=--silent
  [ ! -t 2 ] || progress=--progress-bar

  channel=${MAESTRO_CHANNEL:-stable}
  case $channel in
    stable | rc) ;;
    *) fail "MAESTRO_CHANNEL is '$channel', which is not a channel" "Set MAESTRO_CHANNEL to stable or rc" ;;
  esac

  need sha256sum
  [ -n "${MAESTRO_RELEASE_DIR:-}" ] || need curl
  need tar
  need gzip
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

  say "installing maestro ${tag:-from $MAESTRO_RELEASE_DIR}"
  fetch_assets
  refuse_while_running
  install_assets
  check_requirements
  check_harnesses

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on PATH" "Add it to PATH in your shell profile" ;;
  esac
  say "logged to $log_file"

  "$bin_dir/maestro" --version
}

main "$@"
