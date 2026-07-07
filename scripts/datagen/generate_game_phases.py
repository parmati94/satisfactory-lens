#!/usr/bin/env python3
"""
Generate the Space Elevator / Project Assembly phase cost catalog.

Each phase (GP_Project_Assembly_Phase_N) defines mCosts — the Space Elevator parts
(and amounts) required to advance INTO that phase. The save only stores what's been
delivered (mTargetGamePhasePaidOffCosts) + the AGS multiplier
(BP_GameState_C.mSpacePartsCostMultiplier); the base required amounts live only in
these assets. Actual required = base × multiplier, applied at read time.

Source: pak asset JSON (FModel/CUE4Parse export). The Docs (en-US.json) do NOT
include FGGamePhase, so we read the GamePhases/*.json exports directly.

Output: backend/data/gamePhases.json  →  [ { phase, costs: [ { item, amount } ] }, ... ]
"""

import json
import re
from pathlib import Path

from _paths import CONTENT, BACKEND_DATA, require_pak  # noqa: E402

PHASE_DIR = CONTENT / 'FactoryGame' / 'GamePhases'
OUT = BACKEND_DATA / 'gamePhases.json'

_ITEM_RE = re.compile(r"(Desc_[A-Za-z0-9_]+?)_C'")


def main():
    require_pak()
    phases = []
    for jp in sorted(PHASE_DIR.glob('GP_Project_Assembly_Phase_*.json')):
        m = re.search(r'Phase_(\d+)', jp.stem)
        if not m:
            continue
        idx = int(m.group(1))
        export = json.loads(jp.read_text())[0]
        costs = []
        for c in export.get('Properties', {}).get('mCosts', []) or []:
            obj = (c.get('ItemClass') or {}).get('ObjectName', '')
            im = _ITEM_RE.search(obj)
            if not im:
                continue
            costs.append({'item': im.group(1), 'amount': int(c.get('Amount') or 0)})
        phases.append({'phase': idx, 'costs': costs})

    phases.sort(key=lambda p: p['phase'])
    OUT.write_text(json.dumps(phases, indent=0))
    n = sum(len(p['costs']) for p in phases)
    print(f'Wrote {len(phases)} phases ({n} part costs) → {OUT}')


if __name__ == '__main__':
    main()
