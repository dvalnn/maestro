#!/bin/sh
# Spike 4: compile to out/spike4
set -e
cd "$(dirname "$0")"
mkdir -p out
bun build --compile spike4.ts --outfile out/spike4
