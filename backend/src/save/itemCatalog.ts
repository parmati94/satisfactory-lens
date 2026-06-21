import { readFileSync } from 'fs';
import { join } from 'path';

// The authoritative item catalog (Docs en-US.json → data/items.json), keyed by
// item class (e.g. "Desc_WAT1" → { name: "Somersloop", path, stack }). Shared by
// the /api/items picker route and the save extractors so display names are
// consistent everywhere — and correct for acronym classes the CamelCase heuristic
// mangles (WAT1 → "W A T1").

export interface CatalogEntry { path: string; name: string; stack: number; }

let _catalog: Record<string, CatalogEntry> | null = null;

export function getItemCatalog(): Record<string, CatalogEntry> {
  if (_catalog) return _catalog;
  let loaded: Record<string, CatalogEntry>;
  try {
    loaded = JSON.parse(readFileSync(join(__dirname, '../../data/items.json'), 'utf-8'));
  } catch {
    loaded = {};
  }
  _catalog = loaded;
  return loaded;
}

/** Proper display name for an item class (e.g. "Desc_WAT1"), or null if unknown. */
export function itemName(itemClass: string): string | null {
  return getItemCatalog()[itemClass]?.name ?? null;
}
