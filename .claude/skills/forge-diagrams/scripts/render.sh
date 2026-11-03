#!/usr/bin/env bash
# Renders every Mermaid block of a Markdown file to PNG, in the forge's dark and light themes.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: render.sh <file.md> <out-dir>" >&2; exit 2; }
md=$1 out=$2
mkdir -p "$out"
# mermaid-cli 11.4.1 drives the Chrome build below, which a fresh sandbox has not cached.
chrome=$(npx -y @puppeteer/browsers@3.2.6 install chrome-headless-shell@131.0.6778.204 \
	--path "${XDG_CACHE_HOME:-$HOME/.cache}/puppeteer" 2>/dev/null | tail -1 | sed 's/^[^ ]* //')
printf '{"executablePath":"%s","args":["--no-sandbox"]}' "$chrome" > "$out/puppeteer.json"
awk -v d="$out" '/^```mermaid$/{n++; f=d "/" n ".mmd"; on=1; next} /^```$/{on=0} on{print > f}' "$md"
for f in "$out"/*.mmd; do
	base=${f%.mmd}
	npx -y @mermaid-js/mermaid-cli@11.4.1 -p "$out/puppeteer.json" -t dark -b '#181a1b' -i "$f" -o "$base.dark.png" >/dev/null
	npx -y @mermaid-js/mermaid-cli@11.4.1 -p "$out/puppeteer.json" -b white -i "$f" -o "$base.light.png" >/dev/null
	echo "$base.dark.png $base.light.png"
done
