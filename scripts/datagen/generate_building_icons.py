#!/usr/bin/env python3
"""
Generate building icons for satisfactory-lens from Satisfactory pak data.

Scans all buildable descriptor JSONs (Desc_*.json inside Buildable/),
resolves each descriptor's mPersistentBigIcon texture, decodes it,
and writes Build_<name>.png to the output directory.

Output filename is the Build_ class name (from mBuildableClass), matching
the class names used by the backend (e.g. Build_StorageContainerMk1.png).
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from convert_icons import convert, convert_inline  # noqa: E402

from _paths import PAK_DIR as PAK_BASE, CONTENT, FRONTEND_ASSETS  # noqa: E402

OUT_DIR      = FRONTEND_ASSETS / 'buildings'
BUILDABLE_ROOT = CONTENT / 'FactoryGame' / 'Buildable'


def ue_path_to_uasset(ue_path: str) -> Path | None:
    p = re.sub(r'\.\d+$', '', ue_path.strip())
    if p.startswith('/Game/'):
        rel = 'FactoryGame/Content/' + p[len('/Game/'):]
    else:
        return None
    return (PAK_BASE / rel).with_suffix('.uasset')


def parse_desc(desc_json: Path) -> tuple[str | None, str | None]:
    """
    Returns (build_class_name, icon_ue_path) from a Desc_ JSON file.
    build_class_name is e.g. 'Build_StorageContainerMk1' (no _C suffix).
    """
    try:
        data = json.loads(desc_json.read_text())
    except Exception:
        return None, None

    for entry in data:
        props = entry.get('Properties', {})

        # Extract build class name from mBuildableClass
        build_class = None
        mbc = props.get('mBuildableClass')
        if mbc and isinstance(mbc, dict):
            obj_name = mbc.get('ObjectName', '')
            # "BlueprintGeneratedClass'Build_StorageContainerMk1_C'" → Build_StorageContainerMk1
            m = re.search(r"'(Build_[^']+)'", obj_name)
            if m:
                build_class = m.group(1).removesuffix('_C')

        # Extract icon path
        icon_path = None
        for key in ('mPersistentBigIcon', 'mSmallIcon'):
            icon = props.get(key)
            if icon and isinstance(icon, dict):
                p = icon.get('ObjectPath')
                if p:
                    icon_path = p
                    break

        if build_class or icon_path:
            return build_class, icon_path

    return None, None


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    desc_files = sorted(BUILDABLE_ROOT.rglob('Desc_*.json'))
    print(f'Found {len(desc_files)} buildable descriptor files')

    ok = skip = fail = 0

    for desc_json in desc_files:
        build_class, icon_ue_path = parse_desc(desc_json)

        if not build_class or not icon_ue_path:
            skip += 1
            continue

        out_png = OUT_DIR / f'{build_class}.png'
        if out_png.exists():
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
            print(f'  {build_class}.png')
        else:
            fail += 1
            print(f'  FAIL: {build_class} ({uasset.name})')

    print(f'\nDone: {ok} generated, {skip} skipped, {fail} failed')
    print(f'Icons written to: {OUT_DIR}')


if __name__ == '__main__':
    main()
