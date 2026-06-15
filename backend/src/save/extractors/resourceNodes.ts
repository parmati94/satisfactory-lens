import { isSaveEntity } from '@etothepii/satisfactory-file-parser';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { readFileSync } from 'fs';
import { join } from 'path';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

const NODE_TYPE_PATHS = new Set([
  '/Game/FactoryGame/Resource/BP_ResourceNode.BP_ResourceNode_C',
  '/Game/FactoryGame/Resource/BP_ResourceNodeGeyser.BP_ResourceNodeGeyser_C',
  '/Game/FactoryGame/Resource/BP_FrackingCore.BP_FrackingCore_C',
  '/Game/FactoryGame/Resource/BP_FrackingSatellite.BP_FrackingSatellite_C',
]);

const RESOURCE_ICON: Record<string, string> = {
  'Desc_OreIron':     'iron_ore.png',
  'Desc_OreCopper':   'copper_ore.png',
  'Desc_Coal':        'coal.png',
  'Desc_OreBauxite':  'bauxite.png',
  'Desc_OreGold':     'caterium_ore.png',
  'Desc_OreUranium':  'uranium_ore.png',
  'Desc_SAM':         'sam_ore.png',
  'Desc_Stone':       'limestone.png',
  'Desc_Sulfur':      'sulfur.png',
  'Desc_LiquidOil':   'crude_oil.png',
  'Desc_RawQuartz':   'raw_quartz.png',
  'Desc_NitrogenGas': 'nitrogen_gas.png',
  'Desc_Water':       'water.png',
};

const RESOURCE_LABEL: Record<string, string> = {
  'Desc_OreIron':     'Iron Ore',
  'Desc_OreCopper':   'Copper Ore',
  'Desc_Coal':        'Coal',
  'Desc_OreBauxite':  'Bauxite',
  'Desc_OreGold':     'Caterium Ore',
  'Desc_OreUranium':  'Uranium Ore',
  'Desc_SAM':         'SAM Ore',
  'Desc_Stone':       'Limestone',
  'Desc_Sulfur':      'Sulfur',
  'Desc_LiquidOil':   'Crude Oil',
  'Desc_RawQuartz':   'Raw Quartz',
  'Desc_NitrogenGas': 'Nitrogen Gas',
  'Desc_Water':       'Water',
};

interface NodeLookupEntry {
  instance: string;
  bpType:   string;
  resource: string;
  purity:   string;
  position: { x: number; y: number; z: number };
}

// Load static lookup built from sublevel umap scan. Keys are bare instance paths
// like "PersistentLevel.BP_ResourceNode603" (save prefixes these with "Persistent_Level:").
const NODE_LOOKUP: Record<string, NodeLookupEntry> = (() => {
  try {
    const dataPath = join(__dirname, '../../../data/resource-nodes.json');
    return JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch {
    return {};
  }
})();

// Save instance names look like "Persistent_Level:PersistentLevel.BP_ResourceNode620"
// The lookup keys are "PersistentLevel.BP_ResourceNode620"
function lookupKey(saveInstanceName: string): string {
  const colon = saveInstanceName.indexOf(':');
  return colon !== -1 ? saveInstanceName.slice(colon + 1) : saveInstanceName;
}

function nodeType(typePath: string): string {
  if (typePath.includes('Geyser'))            return 'geyser';
  if (typePath.includes('FrackingCore'))      return 'well_core';
  if (typePath.includes('FrackingSatellite')) return 'well_satellite';
  return 'solid';
}

export interface ResourceNode {
  instanceName: string;
  resourceClass: string;
  label: string;
  icon: string;
  purity: string;
  nodeType: string;
  position: { x: number; y: number; z: number };
}

export function extractResourceNodes(save: SatisfactorySave): ResourceNode[] {
  const nodes: ResourceNode[] = [];

  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (!NODE_TYPE_PATHS.has(obj.typePath)) continue;
      if (!isSaveEntity(obj)) continue;

      const entry = NODE_LOOKUP[lookupKey(obj.instanceName)];
      const key   = entry?.resource ?? '';
      const purity = entry?.purity ?? 'Unknown';

      nodes.push({
        instanceName:  obj.instanceName,
        resourceClass: key,
        label:         RESOURCE_LABEL[key] ?? (key || 'Unknown'),
        icon:          RESOURCE_ICON[key] ?? '',
        purity,
        nodeType:      nodeType(obj.typePath),
        position: entry?.position ?? {
          x: Math.round(obj.transform.translation.x),
          y: Math.round(obj.transform.translation.y),
          z: Math.round(obj.transform.translation.z),
        },
      });
    }
  }

  return nodes;
}
