#!/usr/bin/env python3
"""Emit the mount-path stems of every icon texture referenced by item/building
descriptors, for `sf-extract raw-list`. Reads the descriptor JSONs the extractor
already produced (so the texture set is exactly what the icon generators resolve).

Usage: icon_textures.py <CONTENT_DIR>   # prints one stem per line to stdout
  e.g. .../extracted/FactoryGame/Content  →  FactoryGame/Content/FactoryGame/.../IconDesc_X_256
"""
import glob
import json
import re
import sys
from pathlib import Path

CONTENT = Path(sys.argv[1])
GLOBS = ('Desc_*.json', 'BP_EquipmentDescriptor*.json', 'BP_ItemDescriptor*.json')

stems: set[str] = set()
for g in GLOBS:
    for p in glob.glob(str(CONTENT / '**' / g), recursive=True):
        try:
            data = json.load(open(p))
        except Exception:
            continue
        for export in data:
            props = export.get('Properties', {})
            # Both fields — extract a superset so whichever the generator picks is present.
            for key in ('mPersistentBigIcon', 'mSmallIcon'):
                ic = props.get(key)
                if isinstance(ic, dict):
                    op = re.sub(r'\.\d+$', '', ic.get('ObjectPath') or '')
                    if op.startswith('/Game/'):
                        # /Game/ is the Content root → FactoryGame/Content/<rest>
                        stems.add('FactoryGame/Content/' + op[len('/Game/'):])

for s in sorted(stems):
    print(s)
