#!/usr/bin/env python3
"""Post-generation coverage check. Two jobs, both high-signal and quiet:

  1. Hard gate — every catalogued item has an icon (catches an extraction/order bug
     that would ship an item with no art).
  2. Baseline diff — compares each generated catalog against the committed version
     (git HEAD) and reports what was ADDED (new content — informational) and REMOVED
     (the universal "a glob broke / content vanished" signal — flagged).

Quiet by design: on an unchanged re-run there's nothing to add/remove, so it just
prints counts and "OK". On a game update it shows exactly what changed. No filter
logic is duplicated, so it never cries wolf over intentional exclusions (fluids,
placeholder icons, …) — those are already absent from both sides of the diff.

Exit non-zero if an item lacks an icon, or entries were removed from any catalog.
"""
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

from _paths import BACKEND_DATA, FRONTEND_ASSETS  # noqa: E402

problems: list[str] = []


def load(p: Path):
    return json.loads(p.read_text())


def keys_of(obj) -> set[str]:
    """Top-level identity set: dict keys, or each list item's 'class'."""
    if isinstance(obj, dict):
        return set(obj)
    return {x.get('class', repr(i)) for i, x in enumerate(obj)}


def committed_keys(rel: str) -> set[str] | None:
    """Identity set from the git-committed version of a backend/data file."""
    try:
        blob = subprocess.run(['git', 'show', f'HEAD:{rel}'], capture_output=True, check=True).stdout
        return keys_of(json.loads(blob))
    except Exception:
        return None  # new file / not in git → skip the diff


print("== coverage check ==")

# 1. Hard gate: every catalogued item has an icon.
items = load(BACKEND_DATA / 'items.json')
item_icons = {p.stem for p in (FRONTEND_ASSETS / 'items').glob('*.png')}
for cls in items:
    if cls not in item_icons:
        problems.append(f"item '{cls}' is in items.json but has NO icon")

# 2. Progression breakdown (informational — shows tiers/MAM/shop coverage at a glance).
schem = load(BACKEND_DATA / 'schematics.json')
by_cat = Counter(x.get('category') for x in schem)
print(f"items {len(items)} (icons {len(item_icons)}) | "
      f"recipes {len(load(BACKEND_DATA / 'recipes.json'))} | "
      f"schematics {len(schem)} {dict(by_cat)}")
print(f"buildings: names {len(load(BACKEND_DATA / 'buildable_names.json'))} | "
      f"icons {len(list((FRONTEND_ASSETS / 'buildings').glob('*.png')))}")

# 3. Baseline diff vs committed — added (new content) / removed (regression signal).
print("\nvs committed baseline:")
CATALOGS = ['items.json', 'recipes.json', 'schematics.json',
            'buildable_names.json', 'buildable-footprints.json']
for name in CATALOGS:
    rel = f'backend/data/{name}'
    cur = keys_of(load(BACKEND_DATA / name))
    old = committed_keys(rel)
    if old is None:
        print(f"  {name}: (no committed baseline — skipped)")
        continue
    added, removed = cur - old, old - cur
    if not added and not removed:
        print(f"  {name}: unchanged ({len(cur)})")
        continue
    print(f"  {name}: +{len(added)} / -{len(removed)}")
    if added:
        print(f"      added:   {sorted(added)[:8]}{' …' if len(added) > 8 else ''}")
    if removed:
        print(f"      removed: {sorted(removed)[:8]}{' …' if len(removed) > 8 else ''}")
        problems.append(f"{len(removed)} entr{'y' if len(removed)==1 else 'ies'} removed from {name}")

print()
if problems:
    print(f"REVIEW: {len(problems)} issue(s) —")
    for p in problems:
        print(f"  ⚠ {p}")
    print("(removals can be legit game removals — confirm, then re-commit to re-baseline)")
    sys.exit(1)
print("OK: every item has an icon; no catalog entries vanished.")
