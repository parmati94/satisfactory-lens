#!/usr/bin/env python3
"""
Generate item icons for satisfactory-lens from Satisfactory pak data.

Scans all item/equipment descriptor JSONs, resolves each descriptor's
mPersistentBigIcon (256px) texture, decodes DXT5 from the .ubulk sidecar,
and writes <DescClassName>.png to the output directory.

Output filename matches the itemClass key stored by the backend:
  Desc_IronPlate_C  →  Desc_IronPlate.png
  BP_EquipmentDescriptorHookShot_C  →  BP_EquipmentDescriptorHookShot.png
"""

import json
import re
import sys
from pathlib import Path

# Reuse decode logic from convert_icons.py in the same directory
sys.path.insert(0, str(Path(__file__).parent))
from convert_icons import convert, convert_inline  # noqa: E402

from _paths import PAK_DIR as PAK_BASE, FRONTEND_ASSETS  # noqa: E402

OUT_DIR    = FRONTEND_ASSETS / 'items'

# Descriptor filename prefixes to scan.
# Equip_*.json are equipment actor blueprints (not item descriptors) — excluded.
DESC_GLOBS = [
    'Desc_*.json',
    'BP_EquipmentDescriptor*.json',
    'BP_ItemDescriptor*.json',
]

# Items whose icon references in the pak data point to the wrong texture.
# The game data is wrong for these; fall through to the text fallback.
SKIP_ICON_NAMES = {
    'IconDesc_Beacon_64',           # Desc_AlienFuel accidentally references this
    'BangbyCartridge',              # Desc_Camera accidentally references this
    '01_White', '0_White',          # White placeholder texture — no real icon
    'Lock_Icon',                    # Lock icon — not an item icon
}


def ue_path_to_uasset(ue_path: str) -> Path | None:
    """
    Convert a UE object path to the .uasset file path on disk.
    '/Game/FactoryGame/Foo/Bar.0'  →  PAK_BASE/FactoryGame/Content/FactoryGame/Foo/Bar.uasset
    """
    p = re.sub(r'\.\d+$', '', ue_path.strip())   # strip export index
    if p.startswith('/Game/'):
        rel = 'FactoryGame/Content/' + p[len('/Game/'):]
    else:
        return None
    return (PAK_BASE / rel).with_suffix('.uasset')


def find_icon_path(descriptor_json: Path) -> str | None:
    """Return the UE object path of the best available icon texture."""
    try:
        data = json.loads(descriptor_json.read_text())
    except Exception:
        return None

    for entry in data:
        props = entry.get('Properties', {})
        # Prefer 256px persistent icon; fall back to small
        for key in ('mPersistentBigIcon', 'mSmallIcon'):
            icon = props.get(key)
            if icon and isinstance(icon, dict):
                return icon.get('ObjectPath')
    return None


def class_name_from_file(json_path: Path) -> str:
    """Desc_IronPlate.json → Desc_IronPlate  (strips _C if present)."""
    return json_path.stem.removesuffix('_C')


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    descriptor_files: list[Path] = []
    for glob in DESC_GLOBS:
        descriptor_files.extend(PAK_BASE.rglob(glob))

    descriptor_files = sorted(set(descriptor_files))
    print(f'Found {len(descriptor_files)} descriptor files')

    ok = skip = fail = 0

    for desc_json in descriptor_files:
        cls = class_name_from_file(desc_json)
        out_png = OUT_DIR / f'{cls}.png'

        if out_png.exists():
            skip += 1
            continue

        icon_ue_path = find_icon_path(desc_json)
        if not icon_ue_path:
            skip += 1
            continue

        # Skip known bad icon references where the game data points to the wrong texture
        icon_stem = Path(re.sub(r'\.\d+$', '', icon_ue_path)).stem
        if icon_stem in SKIP_ICON_NAMES:
            skip += 1
            continue

        uasset = ue_path_to_uasset(icon_ue_path)
        if not uasset or not uasset.exists():
            skip += 1
            continue

        if uasset.with_suffix('.ubulk').exists():
            result = convert(str(uasset), str(out_png))
        else:
            result = convert_inline(str(uasset), str(out_png))

        if result:
            ok += 1
        else:
            fail += 1

    print(f'\nDone: {ok} generated, {skip} skipped, {fail} failed')
    print(f'Icons written to: {OUT_DIR}')


if __name__ == '__main__':
    main()
