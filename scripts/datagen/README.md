# Data-generation pipeline

These scripts regenerate the committed game-data (`backend/data/*.json`,
`frontend/public/assets/**`) that Lens ships. You run them when Satisfactory
ships an update; their output is committed to the repo, so end users never run
them.

They read from an **external** Satisfactory pak extraction (~14 GB, not in the
repo) and write **into** this checkout.

## Inputs

Point the pipeline at your pak extraction with `SATISFACTORY_PAK_DIR`
(default `~/.gamedata/satisfactory-pak-data`). That directory must contain:

- `FactoryGame/Content/…` — the full FModel/CUE4Parse pak export (UE assets as
  `.json` + `.uasset`/`.ubulk`/`.glb` sidecars). Export with the matching UE
  version and `FactoryGame.usmap` loaded.
- `en-US.json` — the game's own Docs export (from
  `CommunityResources/Docs/`). Authoritative source for item/recipe/schematic
  names, stack sizes, tiers.

All path resolution lives in [`_paths.py`](_paths.py); nothing is hardcoded.

## Setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export SATISFACTORY_PAK_DIR=/path/to/satisfactory-pak-data   # if not the default
```

The JSON-only generators (recipes/schematics/item_catalog/buildable_names/
extract_node_data) need no third-party deps — only the icon/relief/heightmap
ones do.

## Generators

Run from anywhere; each resolves its own paths. Order only matters where noted.

| Script | Reads | Writes |
| --- | --- | --- |
| `extract_node_data.py` | `Persistent_Level.json` | `backend/data/resource-nodes.json` |
| `generate_heightmap.py` | height `.ubulk` + resource-nodes.json¹ | `backend/data/heightmap.bin` + `-meta.json` |
| `generate_item_catalog.py` | `en-US.json` + pak + item icons | `backend/data/items.json` |
| `generate_recipes.py` | `en-US.json` | `backend/data/recipes.json` |
| `generate_schematics.py` | `en-US.json` + pak | `backend/data/schematics.json` |
| `generate_buildable_names.py` | `Build_*.json` | `backend/data/buildable_names.json` |
| `generate_building_footprints.py` | `Build_*.json` + `.glb` meshes | `backend/data/buildable-footprints.json` + `frontend/.../building-relief/*.png` |
| `generate_item_icons.py` | item descriptors + `.ubulk` | `frontend/.../items/*.png` |
| `generate_building_icons.py` | buildable descriptors + `.ubulk` | `frontend/.../buildings/*.png` |
| `generate_markers.py` | UI textures | `frontend/.../players/*.png` |

¹ `generate_heightmap.py` self-calibrates against `resource-nodes.json`, so run
`extract_node_data.py` first.

`convert_icons.py` is a shared `.uasset`→PNG decode helper (imported by the icon
generators; also runnable standalone: `convert_icons.py <in_dir> <out_dir>`).

Map tiles are a separate step — see [`../build_map_tiles.py`](../build_map_tiles.py).

## After regenerating

Bump [`backend/data/DATA_VERSION.json`](../../backend/data/DATA_VERSION.json) to
the game version the data was built from, and commit the regenerated outputs.

Future automation (orchestrator, server-side CUE4Parse extraction) is tracked in
`PLANNING.md` under "Game-version updates".
