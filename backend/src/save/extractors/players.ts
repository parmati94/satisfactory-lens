import { isSaveEntity, isStrProperty, isFloatProperty } from '@etothepii/satisfactory-file-parser';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { buildInstanceMap, extractPlayerInventory, type InventoryItem } from './storage';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

const PLAYER_TYPE_PATH = '/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C';

export interface PlayerInfo {
  instanceName: string;
  playerName: string;
  health: number | null;
  position: { x: number; y: number; z: number };
  inventory: InventoryItem[];
  equipment: InventoryItem[];
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

      const healthProp = obj.properties['mCurrentHealth'];
      const health = healthProp && isFloatProperty(healthProp) ? healthProp.value : null;

      const { inventory, equipment } = extractPlayerInventory(obj.instanceName, byInstance);

      players.push({
        instanceName: obj.instanceName,
        playerName,
        health,
        position: {
          x: Math.round(obj.transform.translation.x),
          y: Math.round(obj.transform.translation.y),
          z: Math.round(obj.transform.translation.z),
        },
        inventory,
        equipment,
      });
    }
  }

  return players;
}
