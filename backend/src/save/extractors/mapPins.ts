import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

export interface HubInfo {
  position: { x: number; y: number; z: number };
}

export interface MapStamp {
  guid: string;
  name: string;
  position: { x: number; y: number; z: number };
  color: { r: number; g: number; b: number };
  iconId: number;
}

export interface MapPinsResult {
  hub: HubInfo | null;
  stamps: MapStamp[];
}

const HUB_PATH     = '/Game/FactoryGame/Buildable/Factory/HubTerminal/Build_HubTerminal.Build_HubTerminal_C';
const MAP_MGR_PATH = '/Script/FactoryGame.FGMapManager';

export function extractMapPins(save: SatisfactorySave): MapPinsResult {
  let hub: HubInfo | null = null;
  const stamps: MapStamp[] = [];

  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.typePath === HUB_PATH && (obj as any).transform?.translation) {
        const t = (obj as any).transform.translation;
        hub = { position: { x: Math.round(t.x), y: Math.round(t.y), z: Math.round(t.z) } };
      }

      if (obj.typePath === MAP_MGR_PATH) {
        const markersProp = (obj.properties as any)['mMapMarkers'];
        if (!markersProp?.values) continue;

        for (const m of markersProp.values) {
          if (m.type !== 'MapMarker') continue;
          const p = m.properties;

          const guidArr = p['markerGuid']?.value as number[] | undefined;
          const guid = guidArr ? guidArr.join('-') : String(Math.random());

          const locProps = p['Location']?.value?.properties;
          if (!locProps) continue;

          const c = p['Color']?.value ?? { r: 0.5, g: 0.5, b: 0.5 };

          stamps.push({
            guid,
            name: (p['Name']?.value as string) ?? '',
            position: {
              x: locProps['X']?.value as number ?? 0,
              y: locProps['Y']?.value as number ?? 0,
              z: locProps['Z']?.value as number ?? 0,
            },
            // Convert linear to sRGB for display
            color: {
              r: Math.round(Math.pow(Math.max(0, c.r), 1 / 2.2) * 255),
              g: Math.round(Math.pow(Math.max(0, c.g), 1 / 2.2) * 255),
              b: Math.round(Math.pow(Math.max(0, c.b), 1 / 2.2) * 255),
            },
            iconId: (p['IconID']?.value as number) ?? 0,
          });
        }
      }
    }
  }

  return { hub, stamps };
}
