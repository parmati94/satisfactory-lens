#!/usr/bin/env bash
# Full server-side extraction: pak/utoc/ucas → extracted/ tree → run the Python
# generators → committed game-data. Replaces the manual FModel export step.
#
# Prereq (one-time): ./fetch-oodle.sh && ./fetch-cue4parse.sh
# Inputs: SATISFACTORY_PAK_DIR/input/ (paks + usmap), refreshed per game update.
#
# Writes the extracted UE assets to <PAK_DIR>/extracted/ (NEVER the manual
# FactoryGame/ tree), then runs every generator against it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATAGEN="$(dirname "$HERE")"
PAK_DIR="${SATISFACTORY_PAK_DIR:-$HOME/.gamedata/satisfactory-pak-data}"
EXTRACTED="$PAK_DIR/extracted"
CONTENT="$EXTRACTED/FactoryGame/Content"

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

echo "== building extractor =="
dotnet build -c Release -v q -nologo "$HERE/Extractor.csproj"
EX=(dotnet run -c Release --no-build --project "$HERE/Extractor.csproj" --)

echo "== extracting assets → $EXTRACTED (fresh) =="
# Start clean so content removed/renamed in a game update doesn't linger as stale
# assets. EXTRACTED is always "<PAK_DIR>/extracted"; guard against a surprise value.
case "$EXTRACTED" in */extracted) rm -rf "$EXTRACTED" ;; *) echo "refusing to rm '$EXTRACTED'"; exit 1 ;; esac
# Property JSON (the catalog/name/schematic/footprint generators read these)
"${EX[@]}" json-tree "FactoryGame/Content/FactoryGame/Buildable" "Build_,BUILD_,SM_"
"${EX[@]}" json-tree "FactoryGame/Content/FactoryGame/Schematics"
"${EX[@]}" json-tree "FactoryGame/Content" "Desc_,BP_EquipmentDescriptor,BP_ItemDescriptor"
"${EX[@]}" json-tree "FactoryGame/Content/FactoryGame/Map/GameLevel01/Persistent_Level.umap"
# Render meshes (footprints/relief)
"${EX[@]}" mesh "FactoryGame/Content/FactoryGame/Buildable"
# Raw textures + heightmap (convert_icons / heightmap parser read raw bytes).
# Icon textures use ~80 different name patterns, so resolve the exact referenced set
# from the just-exported descriptors instead of guessing prefixes.
python3 "$HERE/icon_textures.py" "$CONTENT" > "$EXTRACTED/.icon-textures.txt"
"${EX[@]}" raw-list "$EXTRACTED/.icon-textures.txt"
"${EX[@]}" raw "FactoryGame/Content/FactoryGame/Interface/UI/Assets/MonochromeIcons" "TXUI_MIcon_Pioneer"
"${EX[@]}" raw "FactoryGame/Content/FactoryGame/Interface/UI/Assets/MapTest" "HeightData_Test"

echo "== running generators against extracted tree =="
export SATISFACTORY_CONTENT_DIR="$CONTENT"
run() { echo "-- $1"; python3 "$DATAGEN/$1"; }
run extract_node_data.py        # resource-nodes.json
run generate_recipes.py         # recipes.json (Docs)
run generate_schematics.py      # schematics.json
# Icons FIRST — item_catalog only catalogs items that have a (non-placeholder) icon,
# so the icons must exist before it runs or a new item won't reach items.json.
run generate_item_icons.py      # item icon PNGs
run generate_building_icons.py  # building icon PNGs
run generate_markers.py         # player marker PNG
run generate_item_catalog.py    # items.json (gates on the icons generated above)
run generate_buildable_names.py # buildable_names.json
run generate_building_footprints.py  # buildable-footprints.json + relief PNGs
run generate_heightmap.py       # heightmap.bin + meta (needs resource-nodes first)

echo "== coverage check =="
python3 "$DATAGEN/validate.py" || echo "!! coverage gaps above — a game update may have added content our globs miss"

echo "== done. Review git diff in backend/data + frontend/public/assets, then bump DATA_VERSION.json =="
