#!/usr/bin/env python3
"""
Generate the inventory item catalog for satisfactory-lens save editing.

Authoritative source is the game's own Docs export (`en-US.json`): it lists only
the registered/current item classes with their *resolved* display names, stack
sizes and forms — so cut content (e.g. Metacell) and legacy internal names
(Gold=Caterium) are handled at the source, no manual blocklist/overrides needed.

Docs gives ClassName but not the full asset path the save references, so we
cross-reference the pak files for that.

Output: backend/data/items.json  →  { "Desc_IronPlate": { path, name, stack }, ... }
"""

import json
import re
from pathlib import Path

from _paths import CONTENT, DOCS, BACKEND_DATA, FRONTEND_ASSETS  # noqa: E402

OUT_FILE = BACKEND_DATA / 'items.json'
ICON_DIR = FRONTEND_ASSETS / 'items'

# Native descriptor classes that are genuinely carryable in an inventory.
ITEM_CLASSES = {
    'FGItemDescriptor', 'FGResourceDescriptor', 'FGItemDescriptorBiomass',
    'FGItemDescriptorNuclearFuel', 'FGItemDescriptorPowerBoosterFuel',
    'FGConsumableDescriptor', 'FGEquipmentDescriptor',
    'FGAmmoTypeProjectile', 'FGAmmoTypeInstantHit', 'FGAmmoTypeSpreadshot',
    'FGPowerShardDescriptor',
}

STACK_SIZES = {
    'SS_ONE': 1, 'SS_SMALL': 50, 'SS_MEDIUM': 100,
    'SS_BIG': 200, 'SS_HUGE': 500, 'SS_FLUID': 50000,
}
FLUID_FORMS = {'RF_LIQUID', 'RF_GAS', 'RF_HEAT'}

# Real, inventory-able items that Docs omits because they're pickup-only (not
# craftable/registered). Curated supplement — name here, path/stack from the pak.
EXTRA_ITEMS = {
    'Desc_HardDrive': 'Hard Drive',
    'Desc_ResourceSinkCoupon': 'FICSIT Coupon',
    'Desc_Vines': 'Vines',
}


def load_docs():
    raw = DOCS.read_bytes()
    enc = 'utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    return json.loads(raw.decode(enc))


def build_path_index() -> dict[str, Path]:
    idx: dict[str, Path] = {}
    for glob in ('Desc_*.json', 'BP_EquipmentDescriptor*.json', 'BP_ItemDescriptor*.json'):
        for jp in CONTENT.rglob(glob):
            idx.setdefault(jp.stem, jp)
    return idx


def ue_path(json_path: Path, class_name: str) -> str:
    rel = json_path.relative_to(CONTENT).with_suffix('')
    return f'/Game/{rel.as_posix()}.{class_name}_C'


def main():
    index = build_path_index()
    have_icon = {p.stem for p in ICON_DIR.glob('*.png')} if ICON_DIR.exists() else set()
    docs = load_docs()

    catalog: dict[str, dict] = {}
    missing_path = 0
    for group in docs:
        native = group.get('NativeClass', '').split('.')[-1].rstrip("'")
        if native not in ITEM_CLASSES:
            continue
        for entry in group.get('Classes', []):
            cls = entry.get('ClassName', '').removesuffix('_C')
            if not cls or cls in catalog:
                continue
            form = (entry.get('mForm', '') or '').split('::')[-1]
            if form in FLUID_FORMS:
                continue
            if have_icon and cls not in have_icon:
                continue
            jp = index.get(cls)
            if not jp:
                missing_path += 1
                continue
            stack = STACK_SIZES.get((entry.get('mStackSize', '') or '').split('::')[-1], 100)
            name = entry.get('mDisplayName') or cls
            catalog[cls] = {'path': ue_path(jp, cls), 'name': name, 'stack': stack}

    # Supplement: pickup-only reals Docs leaves out (path + stack from the pak).
    for cls, name in EXTRA_ITEMS.items():
        if cls in catalog:
            continue
        jp = index.get(cls)
        if not jp or (have_icon and cls not in have_icon):
            continue
        stack = 100
        try:
            for entry in json.loads(jp.read_text()):
                ss = entry.get('Properties', {}).get('mStackSize')
                if isinstance(ss, str):
                    stack = STACK_SIZES.get(ss.split('::')[-1], 100)
        except Exception:
            pass
        catalog[cls] = {'path': ue_path(jp, cls), 'name': name, 'stack': stack}

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(catalog, indent=0, sort_keys=True))
    print(f'Wrote {len(catalog)} items → {OUT_FILE}'
          + (f'  ({missing_path} had no pak asset, skipped)' if missing_path else ''))


if __name__ == '__main__':
    main()
