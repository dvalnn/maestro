#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out && mkdir -p out/pack out/pack-bad out/pack-ts
bun build packsrc/index.ts --target=bun --format=esm --outfile=out/pack/index.js
bun build packsrc/bad.ts --target=bun --format=esm --external left-pad --outfile=out/pack-bad/index.js
cp packsrc/index.ts out/pack-ts/index.ts
sed -i 's#"../src/sdk"#"./sdk"#' out/pack-ts/index.ts && cp src/sdk.ts out/pack-ts/sdk.ts
for d in pack:index.js pack-bad:index.js pack-ts:index.ts; do
  printf '{"name":"%s","version":"0.0.1","entry":"%s"}\n' "${d%%:*}" "${d##*:}" > "out/${d%%:*}/maestro-pack.json"
done
bun build --compile src/main.ts --outfile out/spike3
