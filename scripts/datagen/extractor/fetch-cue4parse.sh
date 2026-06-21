#!/usr/bin/env bash
# Vendor CUE4Parse at the exact commit FModel ships (proven-good for Satisfactory).
# vendor/ is gitignored; this re-clones it deterministically.
#
# Pinned to FModel build fe45299's CUE4Parse submodule. Stock CUE4Parse can't parse
# Coffee Stain's shipped usmap regardless of version (OptionalProperty encoding) —
# that's handled by our TolerantUsmap.cs, not by picking a CUE4Parse version. We pin
# purely for a stable, known-good package/mesh/texture reader.
set -euo pipefail

PIN="ab20414ab3661fbfda06afdd00c8b54bc7797c90"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vendor/CUE4Parse"

if [ -d "$DIR/.git" ] && [ "$(git -C "$DIR" rev-parse HEAD 2>/dev/null)" = "$PIN" ]; then
  echo "CUE4Parse already at $PIN"
  exit 0
fi

rm -rf "$DIR"
git clone --filter=blob:none --no-checkout https://github.com/FabianFG/CUE4Parse "$DIR"
git -C "$DIR" checkout "$PIN"
git -C "$DIR" submodule update --init --recursive --depth 1
echo "CUE4Parse vendored at $PIN"
