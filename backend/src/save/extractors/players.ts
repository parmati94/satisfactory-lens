import { isSaveEntity, isStrProperty, isFloatProperty } from '@etothepii/satisfactory-file-parser';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { buildInstanceMap, extractPlayerInventory, type InventoryItem } from './storage';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

const PLAYER_TYPE_PATH = '/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C';

export interface PlayerInfo {
  instanceName: string;
  inventoryName: string; // inventory component entity — the edit target for slots
  playerName: string;
  health: number | null;
  position: { x: number; y: number; z: number };
  inventory: InventoryItem[];
  inventorySlots: number;
  equipment: InventoryItem[];
  equipmentSlots: number;
}

export function extractPlayers(save: SatisfactorySave): PlayerInfo[] {
  const players: PlayerInfo[] = [];
  const byInstance = buildInstanceMap(save);

  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.typePath !== PLAYER_TYPE_PATH) continue;
      if (!isSaveEntity(obj)) continue;

      const nameProp = obj.properties['mCachedPlayerName'];
      const playerName =
        nameProp && isStrProperty(nameProp) ? nameProp.value : 'Unknown';

      // Health lives on a separate FGHealthComponent (referenced by mHealthComponent).
      // At full health mCurrentHealth isn't serialized, so absent → full (100).
      const hcRef: string = (obj.properties['mHealthComponent'] as any)?.value?.pathName ?? '';
      const hc = hcRef ? byInstance.get(hcRef) : null;
      const hcHealthProp = hc?.properties?.mCurrentHealth;
      const health = hc
        ? (hcHealthProp && isFloatProperty(hcHealthProp) ? hcHealthProp.value : 100)
        : null;

      const { inventory, inventorySlots, equipment, equipmentSlots } = extractPlayerInventory(obj.instanceName, byInstance);

      players.push({
        instanceName: obj.instanceName,
        inventoryName: `${obj.instanceName}.inventory`,
        playerName,
        health,
        position: {
          x: Math.round(obj.transform.translation.x),
          y: Math.round(obj.transform.translation.y),
          z: Math.round(obj.transform.translation.z),
        },
        inventory,
        inventorySlots,
        equipment,
        equipmentSlots,
      });
    }
  }

  return players;
}
