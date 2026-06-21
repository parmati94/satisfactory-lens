# Data-generation pipeline

Regenerates the committed game-data (`backend/data/*.json`,
`frontend/public/assets/**`) that Lens ships. You run it when Satisfactory ships
an update; the output is committed to the repo, so end users never run it.

A server-side **CUE4Parse extractor** reads the game paks directly (replacing the
old manual FModel export). The whole pipeline is one command:

```bash
bash scripts/datagen/extractor/extract.sh
```

It extracts the assets it needs, runs every generator against them, and finishes
with a coverage check. Inputs come from an external data root; outputs land in
this checkout.

## Prerequisites (one-time per machine)

```bash
# 1. .NET 8 SDK — user-local, no sudo. (The extractor + CUE4Parse target net8.0.)
curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir ~/.dotnet

# 2. Python deps for the generators (icon/relief/heightmap; JSON-only ones need nothing)
python3 -m venv scripts/datagen/.venv && . scripts/datagen/.venv/bin/activate
pip install -r scripts/datagen/requirements.txt

# 3. Extractor native deps — fetched into the gitignored vendor/ and runtime/
cd scripts/datagen/extractor
./fetch-oodle.sh        # Oodle decompression .so (CUE4Parse needs it for UE5 IoStore)
./fetch-cue4parse.sh    # vendors CUE4Parse at FModel's pinned commit
```

`extract.sh` puts `~/.dotnet` on its own PATH, so you don't need `dotnet` on your
global PATH. Nothing here is an env var that evaporates — it's all on-disk installs.

## Inputs

Point the pipeline at your data root with `SATISFACTORY_PAK_DIR`
(default `~/.gamedata/satisfactory-pak-data`). **Refresh `input/` on every game
update** — copy these straight from the game install:

```
<root>/
  input/
    FactoryGame-Windows.{pak,utoc,ucas,sig}   # the game archive (data is in the multi-GB .ucas)
    global.{utoc,ucas}                        # engine/global container
    FactoryGame.usmap                         # type mappings — MUST match the game version
    en-US.json                                # Docs export (CommunityResources/); item/recipe/schematic source
  extracted/                                  # created by extract.sh; wiped+rebuilt each run
  FactoryGame/                                # optional: manual FModel export — see below
```

`FactoryGame/` is the legacy manual FModel extraction. It's no longer required —
the extractor produces everything into `extracted/` instead. It's kept only as a
byte-diff "gold reference" and as the default the icon generators fall back to when
`SATISFACTORY_CONTENT_DIR` isn't set (which `extract.sh` always sets). Deletable
once you trust the pipeline.

All path resolution lives in [`_paths.py`](_paths.py); nothing is hardcoded.

## What `extract.sh` runs

1. Builds the extractor, wipes `extracted/`, and pulls the needed assets:
   property JSON (`json-tree`), raw textures/heightmap (`raw` / `raw-list`), and
   building meshes → glb (`mesh`). Icon textures are resolved from descriptor
   references by [`extractor/icon_textures.py`](extractor/icon_textures.py).
2. Runs every generator (below) against `extracted/`.
3. Runs [`validate.py`](validate.py) — fails if any catalogued item lacks an icon,
   and diffs each catalog vs the committed baseline to surface added (new content)
   / removed (a broken glob) entries.

## Generators

| Script | Reads | Writes |
| --- | --- | --- |
| `extract_node_data.py` | `Persistent_Level` | `backend/data/resource-nodes.json` |
| `generate_heightmap.py` | height `.ubulk` + resource-nodes.json¹ | `backend/data/heightmap.bin` + `-meta.json` |
| `generate_item_catalog.py` | `en-US.json` + pak + item icons² | `backend/data/items.json` |
| `generate_recipes.py` | `en-US.json` | `backend/data/recipes.json` |
| `generate_schematics.py` | `en-US.json` + pak | `backend/data/schematics.json` |
| `generate_buildable_names.py` | `Build_*.json` | `backend/data/buildable_names.json` |
| `generate_building_footprints.py` | `Build_*.json` + `.glb` meshes | `backend/data/buildable-footprints.json` + `frontend/.../building-relief/*.png` |
| `generate_item_icons.py` | item descriptors + `.ubulk` | `frontend/.../items/*.png` |
| `generate_building_icons.py` | buildable descriptors + `.ubulk` | `frontend/.../buildings/*.png` |
| `generate_markers.py` | UI textures | `frontend/.../players/player_marker.png` |

¹ heightmap self-calibrates against `resource-nodes.json` (so nodes run first).
² item_catalog only catalogs items that have an icon, so `extract.sh` runs the icon
generators before it.

`convert_icons.py` is a shared `.uasset`→PNG decode helper used by the icon
generators. Map tiles are separate — see [`../build_map_tiles.py`](../build_map_tiles.py).

## After regenerating

Review the `git diff` (and the `validate.py` summary), bump
[`backend/data/DATA_VERSION.json`](../../backend/data/DATA_VERSION.json) to the new
game version, and commit. For the app to show new/changed icons, rebuild the
frontend (`npm run build`) and redeploy.

## Running a single generator

`extract.sh` is the full path. To run one generator by hand against the extracted
tree:

```bash
SATISFACTORY_CONTENT_DIR=~/.gamedata/satisfactory-pak-data/extracted/FactoryGame/Content \
  python3 scripts/datagen/generate_recipes.py
```

`SATISFACTORY_ASSETS_DIR` likewise redirects icon/relief output (e.g. to a temp dir
when testing, so committed assets aren't touched).
