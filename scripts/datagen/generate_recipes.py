#!/usr/bin/env python3
"""
Generate the recipe catalog for satisfactory-lens's per-instance machine inspector.

Authoritative source is the game's Docs export (`en-US.json`): the FGRecipe section
gives ingredients/products (item class + amount), the manufacturing duration, and
which machines a recipe is produced in. Item display names + fluid form come from
the item-descriptor sections (so fluid names resolve even though items.json omits
fluids; fluid amounts are stored ×1000 = millilitres and are normalised to m³).

Output: backend/data/recipes.json  →
  { "Recipe_IronPlate": { name, durationSec, ingredients[], products[], producedIn[] }, ... }
keyed by recipe class without the _C suffix (matches the save's mCurrentRecipe path stem).
"""

import json
import re
from pathlib import Path

from _paths import DOCS, BACKEND_DATA  # noqa: E402

OUT = BACKEND_DATA / 'recipes.json'

# Item-descriptor NativeClasses whose entries carry mDisplayName / mForm. Mirrors
# generate_item_catalog.py but is inclusive of fluids (we need their names here).
ITEM_CLASSES = {
    'FGItemDescriptor', 'FGResourceDescriptor', 'FGItemDescriptorBiomass',
    'FGItemDescriptorNuclearFuel', 'FGItemDescriptorPowerBoosterFuel',
    'FGConsumableDescriptor', 'FGEquipmentDescriptor',
    'FGAmmoTypeProjectile', 'FGAmmoTypeInstantHit', 'FGAmmoTypeSpreadshot',
    'FGPowerShardDescriptor',
}
FLUID_FORMS = {'RF_LIQUID', 'RF_GAS', 'RF_HEAT'}

# ItemClass="…/Desc_Foo.Desc_Foo_C'",Amount=12
_ITEM_RE = re.compile(r"ItemClass=.*?\.([A-Za-z0-9_]+?)_C[\"']*\s*,\s*Amount=(\d+)")
# Build_* producer classes from mProducedIn
_BUILD_RE = re.compile(r"\.(Build_[A-Za-z0-9_]+?)_C")


def load_docs():
    raw = DOCS.read_bytes()
    enc = 'utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    return json.loads(raw.decode(enc))


def build_item_map(docs) -> dict[str, dict]:
    """ClassName(no _C) → { name, fluid }."""
    items: dict[str, dict] = {}
    for group in docs:
        native = group.get('NativeClass', '').split('.')[-1].rstrip("'")
        if native not in ITEM_CLASSES:
            continue
        for e in group.get('Classes', []):
            cls = e.get('ClassName', '').removesuffix('_C')
            if not cls:
                continue
            form = (e.get('mForm', '') or '').split('::')[-1]
            items[cls] = {'name': e.get('mDisplayName') or cls, 'fluid': form in FLUID_FORMS}
    return items


def parse_items(raw: str, item_map: dict[str, dict]) -> list[dict]:
    out = []
    for m in _ITEM_RE.finditer(raw or ''):
        item, amount = m.group(1), int(m.group(2))
        info = item_map.get(item, {'name': item, 'fluid': False})
        fluid = info['fluid']
        out.append({
            'item': item,
            'name': info['name'],
            'amount': amount / 1000 if fluid else amount,  # mL → m³ for fluids
            'fluid': fluid,
        })
    return out


def main():
    docs = load_docs()
    item_map = build_item_map(docs)
    recipes = [e for g in docs
               if g['NativeClass'].split('.')[-1].rstrip("'") == 'FGRecipe'
               for e in g['Classes']]

    out: dict[str, dict] = {}
    for e in recipes:
        produced_in = sorted({m.group(1) for m in _BUILD_RE.finditer(e.get('mProducedIn', '') or '')})
        if not produced_in:
            continue  # hand-craft / workshop-only — no automated machine to inspect
        cls = e['ClassName'].removesuffix('_C')
        out[cls] = {
            'name': e.get('mDisplayName') or cls,
            'durationSec': float(e.get('mManufactoringDuration') or 0),
            'ingredients': parse_items(e.get('mIngredients', ''), item_map),
            'products': parse_items(e.get('mProduct', ''), item_map),
            'producedIn': produced_in,
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=0, sort_keys=True))
    print(f'Wrote {len(out)} recipes → {OUT}')


if __name__ == '__main__':
    main()
