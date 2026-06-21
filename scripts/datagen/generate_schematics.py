#!/usr/bin/env python3
"""
Generate the schematic (progression) catalog for satisfactory-lens save editing.

Authoritative source is the game's Docs export (`en-US.json`) for names/type/tier;
full asset paths (which the save references in mPurchasedSchematics) come from the
pak. Output is grouped for the Progression tab: Milestones (by tier), MAM Research
(by tree), Alternate Recipes, HUB Upgrades, AWESOME Shop.

Output: backend/data/schematics.json  →  [ { class, path, name, type, category, group, tier, order }, ... ]
"""

import json
import re
from pathlib import Path

from _paths import CONTENT, DOCS, BACKEND_DATA  # noqa: E402

SCHEM_DIR = CONTENT / 'FactoryGame' / 'Schematics'
OUT = BACKEND_DATA / 'schematics.json'

# Docs mType → (category label, order). Only types where "unlocked vs not" is
# meaningful. EST_ResourceSink is the AWESOME Shop — kept ONLY for one-time
# unlocks (BP_UnlockRecipe: floor holes, materials, decor); the repeatable coupon
# purchases (BP_UnlockGiveItem: iron rod, etc.) are filtered out below. Excluded
# entirely: EST_Tutorial (HUB onboarding), EST_Custom / EST_HardDrive.
CATEGORY = {
    'EST_Milestone':     ('Milestones', 1),
    'EST_MAM':           ('MAM Research', 2),
    'EST_Alternate':     ('Alternate Recipes', 3),
    'EST_ResourceSink':  ('AWESOME Shop', 4),
    'EST_Customization': ('AWESOME Shop', 4),
}


def load_docs():
    raw = DOCS.read_bytes()
    enc = 'utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    return json.loads(raw.decode(enc))


# Consolidate MAM tree tokens (from the class name) into in-game tree names.
MAM_TREE = {
    'AO': 'Alien Organisms', 'AOrganisms': 'Alien Organisms',
    'AOrgans': 'Alien Organisms', 'ACarapace': 'Alien Organisms',
    'Alien': 'Alien Technology', 'Nutrients': 'Nutritional', 'XMas': 'FICSMAS',
}


def prettify(token: str) -> str:
    return re.sub(r'([a-z])([A-Z])', r'\1 \2', token).strip()


# Representative icon for a schematic = the Desc_ class of the first recipe it
# unlocks (item or building) — that's what the in-game tree shows. None for
# non-recipe unlocks (inventory slots, info-only, customizations).
_RECIPE_RE = re.compile(r"\.(Recipe_[^.'\"]+_C)")
_DESC_RE = re.compile(r"(Desc_[A-Za-z0-9_]+)\.")


def resolve_icon(unlocks, recipes) -> str | None:
    for u in unlocks or []:
        if u.get('Class') != 'BP_UnlockRecipe_C':
            continue
        for m in _RECIPE_RE.finditer(u.get('mRecipes', '') or ''):
            r = recipes.get(m.group(1))
            if not r:
                continue
            pm = _DESC_RE.search(r.get('mProduct') or '')
            if pm:
                return pm.group(1)
    return None


def main():
    index = {p.stem: p for p in SCHEM_DIR.rglob('*.json')}
    docs = load_docs()
    schematics = [e for g in docs
                  if g['NativeClass'].split('.')[-1].rstrip("'") == 'FGSchematic'
                  for e in g['Classes']]
    recipes = {e['ClassName']: e for g in docs
               if g['NativeClass'].split('.')[-1].rstrip("'") == 'FGRecipe'
               for e in g['Classes']}

    out = []
    missing = 0
    for e in schematics:
        t = e.get('mType')
        if t not in CATEGORY:
            continue
        # AWESOME Shop: keep only one-time unlocks (a recipe), not repeatable
        # coupon purchases (give-item) or tapes/info.
        if t == 'EST_ResourceSink':
            unlock_classes = {u.get('Class') for u in (e.get('mUnlocks') or [])}
            if 'BP_UnlockRecipe_C' not in unlock_classes:
                continue

        cls = e['ClassName'].removesuffix('_C')
        jp = index.get(cls)
        if not jp:
            missing += 1
            continue
        category, cat_order = CATEGORY[t]
        tier = int(float(e.get('mTechTier') or 0))

        if t == 'EST_Milestone':
            group = f'Tier {tier}'
        elif t == 'EST_MAM':
            parts = cls.split('_')
            raw = parts[1] if len(parts) > 1 else 'Research'
            group = MAM_TREE.get(raw, prettify(raw))
        elif t == 'EST_Customization':
            group = 'Customizations'
        elif t == 'EST_ResourceSink':
            group = 'Buildings & Decor'
        else:
            group = ''

        rel = jp.relative_to(CONTENT).with_suffix('')
        out.append({
            'class': cls,
            'path': f'/Game/{rel.as_posix()}.{cls}_C',
            'name': e.get('mDisplayName') or cls,
            'type': t,
            'category': category,
            'catOrder': cat_order,
            'group': group,
            'tier': tier,
            'order': float(e.get('mMenuPriority') or 0),
            'icon': resolve_icon(e.get('mUnlocks'), recipes),
        })

    out.sort(key=lambda s: (s['catOrder'], s['tier'], s['order'], s['name']))
    OUT.write_text(json.dumps(out, indent=0))
    print(f'Wrote {len(out)} schematics → {OUT}' + (f'  ({missing} skipped, no pak path)' if missing else ''))


if __name__ == '__main__':
    main()
