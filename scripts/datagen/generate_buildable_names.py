#!/usr/bin/env python3
"""
Generate a Build_ClassName → display_name JSON mapping from pak data.

Uses mDisplayName.Key from Build_*.json files and derives readable names
from the key path + class name (for Mk/material variants).

Output: backend/data/buildable_names.json
"""

import json
import re
import glob
from pathlib import Path

from _paths import CONTENT, BACKEND_DATA  # noqa: E402

OUT_FILE = BACKEND_DATA / 'buildable_names.json'
BUILDABLE_ROOT = CONTENT / 'FactoryGame' / 'Buildable'

# Manual overrides for names the key → name logic gets wrong. These are
# authoritative: seeded into the output up front (see main), so an entry emits
# even when no Build_*/BUILD_*.json globs to it — e.g. BP_ProjectAssembly, the
# one building whose save class breaks the Build_ naming convention.
OVERRIDES = {
    'Build_TradingPost':              'HUB',
    'Build_HubTerminal':              'HUB Terminal',
    'BUILD_Potty_mk1':                'HUB Toilet',
    'Build_WorkBenchIntegrated':      'HUB Workbench',
    'Build_StorageIntegrated':        'HUB Storage',
    'Build_StoragePlayer':            'Personal Storage Box',
    'Build_StorageContainerMk2':      'Storage Container Mk2',
    'Build_GeneratorBiomass_Automated': 'Automated Biomass Burner',
    'Build_GeneratorIntegratedBiomass': 'Integrated Biomass Burner',
    'Build_CentralStorage':           'Dimensional Depot',
    'Build_SpaceElevator':            'Space Elevator',
    'Build_ResourceSink':             'AWESOME Sink',
    'Build_ResourceSinkShop':         'AWESOME Shop',
    'Build_AlienPowerBuilding':       'Alien Power Augmenter',
    'Build_FrackingSmasher':          'Resource Well Pressurizer',
    'Build_FrackingExtractor':        'Resource Well Extractor',
    'Build_MinerMk1':                 'Miner Mk1',
    'Build_MinerMk2':                 'Miner Mk2',
    'Build_MinerMk3':                 'Miner Mk3',
    'Build_RadarTower':               'Radar Tower',
    'Build_DroneStation':             'Drone Port',
    'Build_FoundationPassthrough_Lift': 'Conveyor Lift Passthrough',
    'Build_Mam':                      'MAM',
    'Build_BlueprintDesigner':        'Blueprint Designer Mk1',
    'Build_BlueprintDesigner_MK2':    'Blueprint Designer Mk2',
    'Build_BlueprintDesigner_Mk3':    'Blueprint Designer Mk3',
    'Build_ConveyorAttachmentSplitter':           'Conveyor Splitter',
    'Build_ConveyorAttachmentSplitterLift':       'Conveyor Splitter (Lift)',
    'Build_ConveyorAttachmentSplitterSmart':      'Smart Splitter',
    'Build_ConveyorAttachmentSplitterSmartLift':  'Smart Splitter (Lift)',
    'Build_ConveyorAttachmentSplitterProgrammable':     'Programmable Splitter',
    'Build_ConveyorAttachmentSplitterProgrammableLift': 'Programmable Splitter (Lift)',
    'Build_ConveyorAttachmentMerger':             'Conveyor Merger',
    'Build_ConveyorAttachmentMergerLift':         'Conveyor Merger (Lift)',
    'Build_ConveyorAttachmentMergerPriority':     'Priority Merger',
    'Build_ConveyorAttachmentMergerPriorityLift': 'Priority Merger (Lift)',
    'Build_PipeHyperStart':           'Hypertube Entrance',
    'Build_PipeHyperSupport':         'Hypertube Support',
    'Build_PipeHyper':                'Hypertube',
    'Build_HyperTubeWallSupport':     'Hypertube Wall Support',
    'Build_LandingPad':               'Drone Landing Pad',
    'Build_LookoutTower':             'Lookout Tower',
    'BP_ProjectAssembly':             'Project Assembly',
}

# Material/style suffixes we want to append when derived from class name
MATERIAL_PATTERNS = [
    (r'_ConcretePolished(?:_|$)', ' (Polished Concrete)'),
    (r'_Polished(?:_|$)',         ' (Polished)'),
    (r'_Asphalt(?:_|$)',          ' (Asphalt)'),
    (r'_Metal(?:_|$)',            ' (Metal)'),
    (r'_GripMetal(?:_|$)',        ' (Grip Metal)'),
    (r'_Grip(?:_|$)',             ' (Grip)'),
    (r'_Concrete(?:_|$)',         ' (Concrete)'),
    (r'_Orange(?:_|$)',           ' (Orange)'),
    (r'_Steel(?:_|$)',            ' (Steel)'),
    (r'_Glass(?:_|$)',            ' (Glass)'),
    (r'_Window(?:_|$)',           ' (Window)'),
    (r'_Tar(?:_|$)',              ' (Tar)'),
    (r'_Ficsit(?:_|$)',           ' (FICSIT)'),
    (r'_A(?:_|$)',                ''),  # generic _A variant, strip silently
]

SIZE_PATTERN = re.compile(r'_(\d+x\d+)(?:_|$)')
MK_PATTERN = re.compile(r'(?:MK|Mk|mk)(\d+)', re.IGNORECASE)


def camel_to_words(s: str) -> str:
    """Convert CamelCase (and digit transitions) to Title Case words."""
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', s)
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', s)
    s = re.sub(r'([a-zA-Z])(\d)', r'\1 \2', s)   # Foundation4m → Foundation 4m
    s = re.sub(r'(\d)([a-zA-Z])', r'\1 \2', s)   # 4mWall → 4m Wall
    # Re-join size units: "4 m" → "4m", "8 x 4" → "8x4"
    s = re.sub(r'(\d) m\b', r'\1m', s)
    s = re.sub(r'(\d) x (\d)', r'\1x\2', s)
    # Normalize "Mk 1" → "Mk1"
    s = re.sub(r'\bMk (\d)', r'Mk\1', s)
    return s.strip()


def key_to_display(key: str, class_name: str) -> str | None:
    """Derive a display name from a string table key + class name."""
    if not key:
        return None

    # Use only the last path segment of the key
    leaf = key.split('/')[-1]

    # If the leaf looks like a GUID (hex string), skip
    if re.match(r'^[0-9A-F]{16,}$', leaf):
        return None

    # Convert camelCase leaf to words
    name = camel_to_words(leaf)

    # Append Mk variant from class name if not already in name
    mk_match = MK_PATTERN.search(class_name)
    n = mk_match.group(1) if mk_match else None
    already_has_mk = n and (f'Mk{n}' in name or f'MK{n}' in name or f'Mk {n}' in name)
    if mk_match and not already_has_mk:
        name = f'{name} Mk{mk_match.group(1)}'

    # Append material suffix if present in class name
    cls_suffix = class_name
    for pattern, replacement in MATERIAL_PATTERNS:
        m = re.search(pattern, cls_suffix, re.IGNORECASE)
        if m:
            name = name + replacement
            break

    # Append size suffix (e.g. 8x4 → 4m equivalent; or just keep as-is)
    # We keep the raw key name which usually includes size info already

    return name.strip() or None


def main():
    # Seed with the authoritative overrides so they emit regardless of the glob.
    out: dict[str, str] = dict(OVERRIDES)

    build_jsons = sorted(BUILDABLE_ROOT.rglob('Build_*.json')) + sorted(BUILDABLE_ROOT.rglob('BUILD_*.json'))
    print(f'Scanning {len(build_jsons)} Build_*.json files...')

    for path in build_jsons:
        cls = path.stem  # e.g. "Build_SmelterMk1"

        # Overrides win — already seeded, so leave them untouched.
        if cls in OVERRIDES:
            continue

        try:
            data = json.loads(path.read_text())
        except Exception:
            continue

        for entry in data:
            props = entry.get('Properties', {})
            dn = props.get('mDisplayName')
            if not dn or not isinstance(dn, dict):
                continue

            # Prefer actual decoded string if it differs from the key
            src = dn.get('SourceString') or dn.get('LocalizedString') or ''
            key = dn.get('Key') or ''

            if src and src != key and not re.match(r'^[0-9A-F]{16,}$', key):
                out[cls] = src
            else:
                derived = key_to_display(key, cls)
                if derived:
                    out[cls] = derived
            break

    # Sort by class name
    out = dict(sorted(out.items()))

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=2))
    print(f'Wrote {len(out)} entries to {OUT_FILE}')

    # Show a sample of key mappings
    print('\nSample entries:')
    samples = ['Build_TradingPost', 'Build_StoragePlayer', 'Build_WorkBenchIntegrated',
               'Build_GeneratorBiomass_Automated', 'Build_StorageContainerMk1',
               'Build_StorageContainerMk2', 'Build_Foundation_8x4_01', 'Build_SmelterMk1',
               'Build_AssemblerMk1', 'BUILD_Potty_mk1', 'Build_PowerPoleMk1', 'Build_PowerPoleMk2']
    for s in samples:
        print(f'  {s}: {out.get(s, "(not found)")}')


if __name__ == '__main__':
    main()
