// Save editing — the edit-buffer overlay (player position/health, inventory
// slots, schematic unlocks) and the persist flow, split out of app.js. Spread
// into the Alpine 'app' component (`...saveEditing()`) so methods run against the
// shared `this` proxy. NOTE: all edit *state* (editBuffer, the editCount getter,
// the modals) stays in app.js on purpose — object spread copies a getter's value,
// not the getter, which would break editCount's reactivity.
import { api } from './api.js';

export function saveEditing() {
  return {
    // ── Save editing ──────────────────────────────────────────────────────
    // Override dictionary keyed by stable target; values are absolute (set-
    // semantics). Display = baseline (svPlayers) overlaid with overrides. Undo =
    // remove the key; net-zero (back to baseline) auto-removes. No reverse replay.

    _posKey(player) { return `player:${player.instanceName}:position`; },

    // Effective position = override if present, else the loaded baseline (cm).
    effectivePosition(player) {
      return this.editBuffer[this._posKey(player)]?.value ?? player.position;
    },

    isPositionEdited(player) {
      return !!this.editBuffer[this._posKey(player)];
    },

    // Stage an absolute player position (cm). Net-zero vs the loaded baseline drops
    // the override entirely. Shared by the Explorer's per-axis inputs and the map's
    // click-to-teleport, so both write the identical SetPlayerPosition edit.
    _stagePlayerPosition(player, next) {
      if (!this.isAdmin) return;
      const base = player.position;
      const key = this._posKey(player);
      if (next.x === base.x && next.y === base.y && next.z === base.z) {
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
      } else {
        this.editBuffer = {
          ...this.editBuffer,
          [key]: {
            kind: 'SetPlayerPosition', target: player.instanceName, value: next,
            label: player.playerName,
            changeText: `Teleport → ${(next.x / 100).toFixed(0)}, ${(next.y / 100).toFixed(0)}, ${(next.z / 100).toFixed(0)} m`,
          },
        };
      }
    },

    // Set one axis from a meters input; stores cm (game units) to match the save.
    setPlayerPositionAxis(player, axis, meters) {
      const cm = Math.round((parseFloat(meters) || 0) * 100);
      this._stagePlayerPosition(player, { ...this.effectivePosition(player), [axis]: cm });
    },

    // Stage a teleport to a map-picked X/Y, snapping Z to terrain (+3 m) like
    // snapToGround. Falls back to the player's current altitude if the spot is
    // outside the mapped world (no heightmap there). Used by the map click menu.
    async teleportPlayerToGround(player, gameX, gameY) {
      const x = Math.round(gameX), y = Math.round(gameY);
      let z = this.effectivePosition(player).z; // fallback: keep current altitude
      try {
        const r = await api.groundHeight(x, y);
        if (r && typeof r.z === 'number') z = r.z + 300; // terrain + 3 m safety
      } catch { /* outside the mapped world — keep current altitude */ }
      this._stagePlayerPosition(player, { x, y, z });
    },

    editList() { return Object.values(this.editBuffer); },

    // Snap the player's Z to terrain height (+3 m safety) at its current X/Y, so
    // teleporting drops you just above the ground instead of into a mountain/midair.
    async snapToGround(player) {
      if (!this.isAdmin) return;
      const pos = this.effectivePosition(player);
      try {
        const r = await api.groundHeight(pos.x, pos.y);
        if (r && typeof r.z === 'number') {
          let z = r.z + 300; // terrain + 3 m safety
          // The heightmap is terrain-only (no player-built foundations). If you're
          // snapping in place and already standing higher than terrain (e.g. on a
          // foundation), keep that footing rather than dropping you into it.
          const inPlace = pos.x === player.position.x && pos.y === player.position.y;
          if (inPlace && player.position.z > z) z = player.position.z;
          this.setPlayerPositionAxis(player, 'z', z / 100);
        }
      } catch {
        this.actionResult = { ok: false, message: 'No ground height there (outside the mapped world).' };
      }
    },

    // ── Inventory slot editing ────────────────────────────────────────────
    async loadItemCatalog() {
      if (this.itemCatalog) return;
      try { this.itemCatalog = await api.items(); } catch { this.itemCatalog = {}; }
    },

    _slotKey(invName, slot) { return `inv:${invName}:slot:${slot}`; },

    isSlotEdited(invName, slot) { return !!this.editBuffer[this._slotKey(invName, slot)]; },

    // Effective slot for display: override if present (or null if cleared), else baseline.
    effectiveSlot(invName, slot, baselineSlot) {
      const e = this.editBuffer[this._slotKey(invName, slot)];
      if (!e) return baselineSlot;
      const v = e.value;
      if (!v.item || !(v.count > 0)) return null; // cleared
      const cls = v.item.split('.').pop().replace(/_C$/, '');
      return { slotIndex: slot, itemClass: cls, displayName: this.itemCatalog?.[cls]?.name ?? cls, count: v.count };
    },

    // baseline slot grid overlaid with staged overrides.
    effectiveSlotGrid(invName, contents, totalSlots) {
      return this.slotGrid(contents, totalSlots).map((slot, idx) => this.effectiveSlot(invName, idx, slot));
    },

    async openSlotEditor(invName, slot, contextLabel, baselineSlot, ev) {
      if (!this.isAdmin) return;
      await this.loadItemCatalog();
      const eff = this.effectiveSlot(invName, slot, baselineSlot);
      // Anchor the popover to the clicked slot (clamped to the viewport in slotEditorStyle()).
      const x = ev?.clientX ?? (window.innerWidth / 2);
      const y = ev?.clientY ?? (window.innerHeight / 2);
      this.slotEditor = {
        show: true, invName, slot, contextLabel,
        search: '',
        selClass: eff?.itemClass ?? '',
        count: eff?.count ?? 1,
        baseline: baselineSlot ?? null,
        x, y,
      };
      this.$nextTick(() => document.getElementById('slot-search')?.focus());
    },

    // Fixed-position style for the anchored popover, clamped so it never leaves the
    // viewport (flips left/up near the right/bottom edges).
    slotEditorStyle() {
      const M = 8, H = 360;
      const vw = window.innerWidth, vh = window.innerHeight;
      // Cap the width to the viewport so the popover never exceeds a narrow screen.
      const W = Math.min(280, vw - 2 * M);
      let left = this.slotEditor.x + 12;
      let top = this.slotEditor.y + 12;
      if (left + W > vw - M) left = Math.max(M, this.slotEditor.x - W - 12);
      if (top + H > vh - M) top = Math.max(M, vh - H - M);
      return `left:${left}px;top:${top}px;width:${W}px`;
    },

    // Short, search-driven item list (a handful, not a wall of icons).
    slotEditorItems() {
      if (!this.itemCatalog) return [];
      const q = this.slotEditor.search.toLowerCase().trim();
      const all = Object.entries(this.itemCatalog).map(([cls, v]) => ({ cls, name: v.name, stack: v.stack }));
      const filtered = q ? all.filter(i => i.name.toLowerCase().includes(q) || i.cls.toLowerCase().includes(q)) : all;
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      return filtered.slice(0, 8);
    },

    selectSlotItem(cls) {
      this.slotEditor.selClass = cls;
      // Default a freshly-picked item to a full stack; keep an existing positive qty.
      if (!(Number(this.slotEditor.count) > 0)) {
        this.slotEditor.count = this.itemCatalog?.[cls]?.stack ?? 1;
      }
    },

    applySlotEdit() {
      const { invName, slot, selClass, count, baseline, contextLabel } = this.slotEditor;
      const key = this._slotKey(invName, slot);
      const cls = selClass;
      const item = cls ? (this.itemCatalog?.[cls]?.path ?? null) : null;
      const cnt = Math.max(0, Math.round(Number(count) || 0));
      const clearing = !item || cnt <= 0;

      // Net-zero vs baseline → drop the override.
      const baseClass = baseline?.itemClass ?? null;
      const baseCount = baseline?.count ?? 0;
      const sameAsBaseline = clearing ? baseClass === null : (cls === baseClass && cnt === baseCount);
      if (sameAsBaseline) {
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
      } else {
        const name = clearing ? null : (this.itemCatalog?.[cls]?.name ?? cls);
        this.editBuffer = {
          ...this.editBuffer,
          [key]: {
            kind: 'SetInventorySlot', target: invName,
            value: { slot, item: clearing ? null : item, count: clearing ? 0 : cnt },
            label: contextLabel,
            changeText: clearing ? `Slot ${slot}: cleared` : `Slot ${slot}: ${name} ×${cnt}`,
          },
        };
      }
      this.slotEditor.show = false;
    },

    // ── Dimensional Depot (Central Storage) editing ───────────────────────
    // Keyed by item path (the depot is an item→amount list, not slots).
    _depotKey(itemPath) { return `depot:${itemPath}`; },
    isDepotEdited(itemPath) { return !!this.editBuffer[this._depotKey(itemPath)]; },

    // Baseline depot items overlaid with staged edits/additions/removals.
    effectiveDepotItems(depot) {
      if (!depot) return [];
      const map = new Map();
      for (const it of depot.items) map.set(it.itemPath, { ...it, edited: false });
      for (const e of Object.values(this.editBuffer)) {
        if (e.kind !== 'SetDepotItem' || e.target !== depot.instanceName) continue;
        const path = e.value.item;
        if (!(e.value.amount > 0)) { map.delete(path); continue; }
        const cls = path.split('.').pop().replace(/_C$/, '');
        const existing = map.get(path);
        map.set(path, {
          itemClass: cls, itemPath: path,
          displayName: existing?.displayName ?? this.itemCatalog?.[cls]?.name ?? cls,
          amount: e.value.amount, edited: true,
        });
      }
      return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    },

    // item = an existing DepotItem (edit, item locked) or null (add a new item).
    async openDepotEditor(depot, item, ev) {
      if (!this.isAdmin) return;
      await this.loadItemCatalog();
      const x = ev?.clientX ?? (window.innerWidth / 2);
      const y = ev?.clientY ?? (window.innerHeight / 2);
      this.depotEditor = {
        show: true, target: depot.instanceName,
        fixedItem: item?.itemPath ?? null,          // locks the item when editing an existing row
        selClass: item?.itemClass ?? '',
        count: item?.amount ?? 100,
        baselineAmount: depot.items.find(i => i.itemPath === (item?.itemPath))?.amount ?? 0,
        search: '', x, y,
      };
      this.$nextTick(() => document.getElementById('depot-search')?.focus());
    },
    depotEditorStyle() {
      const M = 8, H = 360;
      const vw = window.innerWidth, vh = window.innerHeight;
      const W = Math.min(280, vw - 2 * M);
      let left = this.depotEditor.x + 12, top = this.depotEditor.y + 12;
      if (left + W > vw - M) left = Math.max(M, this.depotEditor.x - W - 12);
      if (top + H > vh - M) top = Math.max(M, vh - H - M);
      return `left:${left}px;top:${top}px;width:${W}px`;
    },
    depotEditorItems() {
      if (!this.itemCatalog) return [];
      const q = this.depotEditor.search.toLowerCase().trim();
      const all = Object.entries(this.itemCatalog).map(([cls, v]) => ({ cls, name: v.name, stack: v.stack }));
      const filtered = q ? all.filter(i => i.name.toLowerCase().includes(q) || i.cls.toLowerCase().includes(q)) : all;
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      return filtered.slice(0, 8);
    },
    selectDepotItem(cls) { this.depotEditor.selClass = cls; },

    applyDepotEdit() {
      const { target, selClass, count, baselineAmount, fixedItem } = this.depotEditor;
      // Existing rows carry their real path (works even for items outside the picker);
      // new rows resolve the path from the picked catalog item.
      const path = fixedItem ?? (selClass ? this.itemCatalog?.[selClass]?.path : null);
      if (!path) { this.depotEditor.show = false; return; }
      const amt = Math.max(0, Math.round(Number(count) || 0));
      const key = this._depotKey(path);
      if (amt === baselineAmount) {                 // net-zero → drop the override
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
      } else {
        const cls = path.split('.').pop().replace(/_C$/, '');
        const name = this.itemCatalog?.[cls]?.name ?? cls;
        this.editBuffer = {
          ...this.editBuffer,
          [key]: {
            kind: 'SetDepotItem', target,
            value: { item: path, amount: amt },
            label: 'Dimensional Depot',
            changeText: amt <= 0 ? `Depot: removed ${name}` : `Depot: ${name} → ${amt.toLocaleString()}`,
          },
        };
      }
      this.depotEditor.show = false;
    },

    // Stage a removal of a depot item. Distinguish a staged add (exists only in the
    // buffer, not in the save) from a persisted baseline entry — by PRESENCE in
    // depot.items, not by amount. A persisted entry emptied to 0 in-game stays in
    // mStoredItems forever (amount 0); it's still a baseline entry, so removing it
    // must stage amount:0 for the backend to splice it out — checking `amount === 0`
    // would misread it as a staged add and silently no-op.
    removeDepotItem(depot, item) {
      if (!this.isAdmin) return;
      const key = this._depotKey(item.itemPath);
      const inBaseline = depot.items.some(i => i.itemPath === item.itemPath);
      if (!inBaseline) {                             // staged add → just drop the staged edit
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
        return;
      }
      this.editBuffer = {
        ...this.editBuffer,
        [key]: {
          kind: 'SetDepotItem', target: depot.instanceName,
          value: { item: item.itemPath, amount: 0 },
          label: 'Dimensional Depot',
          changeText: `Depot: removed ${item.displayName}`,
        },
      };
    },

    // ── Machine overclock + recipe editing ───────────────────────────────
    _clockKey(inst) { return `machine:${inst.instanceName}:clock`; },
    isClockEdited(inst) { return !!this.editBuffer[this._clockKey(inst)]; },
    // Effective overclock %, overlaying any staged edit on the baseline.
    effectiveClockPct(inst) {
      const e = this.editBuffer[this._clockKey(inst)];
      return e ? Math.round(e.value * 100) : (inst.clockPct ?? 100);
    },
    // Shards a given % requires: 0 shards caps at 100%, each shard adds +50% to the
    // cap, so >100% needs ⌈(pct−100)/50⌉ (101–150→1, 151–200→2, 201–250→3), max 3.
    clockShards(pct) { return pct <= 100 ? 0 : Math.min(3, Math.ceil((pct - 100) / 50)); },

    setMachineClock(inst, pct) {
      if (!this.isAdmin) return;
      const key = this._clockKey(inst);
      const clamped = Math.max(1, Math.min(250, Math.round(Number(pct) || 0)));
      const baseline = inst.clockPct ?? 100;
      if (clamped === baseline) {                  // net-zero → drop the override
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
        return;
      }
      const shards = this.clockShards(clamped);
      this.editBuffer = {
        ...this.editBuffer,
        [key]: {
          kind: 'SetMachineClock', target: inst.instanceName, value: clamped / 100,
          label: inst.recipeName ? `Machine · ${inst.recipeName}` : 'Machine overclock',
          changeText: `Overclock → ${clamped}%` + (shards ? ` · ${shards} shard${shards > 1 ? 's' : ''}` : ''),
        },
      };
    },

    // Power-shard / somersloop slots reflecting a staged overclock: shows the
    // shards the clock edit will add (ringed), preserving baseline somersloops.
    // Reverts with the edit since it's derived from the editBuffer.
    effectivePotential(inst) {
      const base = inst.potential || [];
      if (!this.isClockEdited(inst)) return base;
      const want = this.clockShards(this.effectiveClockPct(inst));
      const baseShards = base.filter(it => it.itemClass === 'Desc_CrystalShard').length;
      const somersloops = base.filter(it => it.itemClass === 'Desc_WAT1');
      const shards = [];
      for (let i = 0; i < want; i++) {
        shards.push({ itemClass: 'Desc_CrystalShard', displayName: 'Power Shard', count: 1, staged: i >= baseShards });
      }
      return shards.concat(somersloops);
    },

    // ── Map marker editing ────────────────────────────────────────────────
    _markerKey(guid) { return `marker:${guid}`; },
    _markerDelKey(guid) { return `marker:${guid}:delete`; },
    isMarkerEdited(guid) { return !!this.editBuffer[this._markerKey(guid)] || !!this.editBuffer[this._markerDelKey(guid)]; },
    isMarkerDeleted(guid) { return !!this.editBuffer[this._markerDelKey(guid)]; },
    _baselineStamp(guid) { return (this.svMapPins?.stamps || []).find(s => s.guid === guid); },

    // Stamps to draw: staged name/color overlaid, deleted ones removed.
    effectiveStamps() {
      const stamps = this.svMapPins?.stamps || [];
      return stamps
        .filter(s => !this.isMarkerDeleted(s.guid))
        .map(s => {
          const e = this.editBuffer[this._markerKey(s.guid)];
          if (!e) return s;
          return { ...s, name: e.value.name ?? s.name, color: e.value.color ?? s.color, edited: true };
        });
    },

    _hexToRgb(hex) {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
      return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 136, g: 136, b: 136 };
    },
    rgbToHex(c) {
      const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
      return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
    },

    // Merge a name and/or color change into one SetMapMarker edit (net-zero clears it).
    setMarker(guid, { name, color }) {
      if (!this.isAdmin) return;
      const base = this._baselineStamp(guid);
      if (!base) return;
      const key = this._markerKey(guid);
      const cur = this.editBuffer[key]?.value || {};
      const nextName = name !== undefined ? name : (cur.name !== undefined ? cur.name : base.name);
      const nextColor = color !== undefined ? color : (cur.color !== undefined ? cur.color : base.color);
      const sameName = nextName === base.name;
      const sameColor = nextColor.r === base.color.r && nextColor.g === base.color.g && nextColor.b === base.color.b;
      if (sameName && sameColor) {
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
      } else {
        const parts = [];
        if (!sameName) parts.push('renamed');
        if (!sameColor) parts.push('recolored');
        this.editBuffer = {
          ...this.editBuffer,
          [key]: {
            kind: 'SetMapMarker', target: guid,
            value: { name: nextName, color: nextColor },
            label: `Marker · ${base.name || '(unnamed)'}`,
            changeText: `Marker ${parts.join(' + ')} → ${nextName || '(unnamed)'}`,
          },
        };
      }
      this._refreshStamps();
    },

    deleteMarker(guid) {
      if (!this.isAdmin) return;
      const base = this._baselineStamp(guid);
      if (!base) return;
      const { [this._markerKey(guid)]: _drop, ...rest } = this.editBuffer; // supersede any rename/recolor
      this.editBuffer = {
        ...rest,
        [this._markerDelKey(guid)]: {
          kind: 'DeleteMapMarker', target: guid, value: {},
          label: `Marker · ${base.name || '(unnamed)'}`,
          changeText: `Marker deleted: ${base.name || '(unnamed)'}`,
        },
      };
      if (this.markerMenu) this.markerMenu.open = false;
      this._refreshStamps();
    },
    undeleteMarker(guid) {
      const { [this._markerDelKey(guid)]: _, ...rest } = this.editBuffer;
      this.editBuffer = rest;
      this._refreshStamps();
    },
    _refreshStamps() { if (this.mapInitialized && this._updateMapPinMarkers) this._updateMapPinMarkers(); },

    // Effective (staged-or-baseline) marker colour as hex — drives the menu swatch.
    markerEffectiveHex(guid) {
      const s = this.effectiveStamps().find(x => x.guid === guid);
      return s ? this.rgbToHex(s.color) : '#888888';
    },
    // Whether a marker's colour differs from baseline (for the picker's reset button).
    markerColorEdited(guid) {
      const e = this.editBuffer[this._markerKey(guid)];
      const base = this._baselineStamp(guid);
      if (!e || !base) return false;
      const c = e.value.color;
      return !!c && (c.r !== base.color.r || c.g !== base.color.g || c.b !== base.color.b);
    },

    // ── Game phase (Project Assembly) editing ─────────────────────────────
    _phaseKey() { return this.svGamePhase ? `phase:${this.svGamePhase.target}` : 'phase'; },
    isPhaseEdited() { return !!this.editBuffer[this._phaseKey()]; },
    effectivePhaseIndex() {
      const e = this.editBuffer[this._phaseKey()];
      return e ? e.value.index : (this.svGamePhase?.currentIndex ?? -1);
    },
    setGamePhase(index) {
      if (!this.isAdmin) return;
      if (!this.svGamePhase) return;
      const key = this._phaseKey();
      const idx = Math.max(0, Math.min(this.svGamePhase.count - 1, Math.round(index)));
      if (idx === this.svGamePhase.currentIndex) {   // net-zero → drop
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
        return;
      }
      this.editBuffer = {
        ...this.editBuffer,
        [key]: {
          kind: 'SetGamePhase', target: this.svGamePhase.target, value: { index: idx },
          label: 'Game phase', changeText: `Project Assembly → Phase ${idx}`,
        },
      };
    },

    // ── Player health editing ─────────────────────────────────────────────
    _healthKey(player) { return `player:${player.instanceName}:health`; },
    effectiveHealth(player) {
      const e = this.editBuffer[this._healthKey(player)];
      return e ? e.value : player.health;
    },
    isHealthEdited(player) { return !!this.editBuffer[this._healthKey(player)]; },
    // Effective HP clamped to a 0–100 integer, for the status bar + readout.
    healthPct(player) { return Math.max(0, Math.min(100, Math.round(this.effectiveHealth(player) ?? 0))); },
    // Tailwind tones for the health bar fill / numeric readout (green→yellow→red).
    healthBarClass(player) {
      const h = this.effectiveHealth(player) ?? 0;
      return h > 50 ? 'bg-ok-500' : h > 20 ? 'bg-warn-500' : 'bg-danger-500';
    },
    healthTextClass(player) {
      const h = this.effectiveHealth(player) ?? 0;
      return h > 50 ? 'text-ok-400' : h > 20 ? 'text-warn-400' : 'text-danger-400';
    },
    setPlayerHealthValue(player, hp) {
      if (!this.isAdmin) return;
      const v = Math.max(0, Math.min(100, Math.round(Number(hp) || 0)));
      const key = this._healthKey(player);
      if (v === Math.round(player.health ?? 0)) {
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
      } else {
        this.editBuffer = {
          ...this.editBuffer,
          [key]: { kind: 'SetPlayerHealth', target: player.instanceName, value: v, label: player.playerName, changeText: `Health → ${v} HP` },
        };
      }
    },

    // ── Schematic (progression) editing ───────────────────────────────────
    _schKey(path) { return `sch:${path}`; },
    effectivePurchased(path) {
      const e = this.editBuffer[this._schKey(path)];
      return e ? e.value.purchased : !!this.svSchematics?.[path];
    },
    isSchematicEdited(path) { return !!this.editBuffer[this._schKey(path)]; },
    setSchematicPurchased(sch, purchased) {
      if (!this.isAdmin) return;
      const path = sch.path, key = this._schKey(path);
      const baseline = !!this.svSchematics?.[path];
      if (purchased === baseline) {
        const { [key]: _, ...rest } = this.editBuffer;
        this.editBuffer = rest;
      } else {
        this.editBuffer = {
          ...this.editBuffer,
          [key]: {
            kind: 'SetSchematicPurchased', target: path, value: { purchased },
            label: sch.name, changeText: purchased ? 'Unlock' : 'Re-lock',
          },
        };
      }
    },
    toggleSchematic(sch) { this.setSchematicPurchased(sch, !this.effectivePurchased(sch.path)); },

    // Progression grouping: catalog → [{ category, count, groups:[{group, items}] }], search-filtered.
    groupedSchematics() {
      if (!this.schematicCatalog) return [];
      const q = this.schematicsSearch.toLowerCase().trim();
      const cats = new Map();
      for (const s of this.schematicCatalog) {
        if (q && !s.name.toLowerCase().includes(q)) continue;
        let c = cats.get(s.category);
        if (!c) { c = { category: s.category, groups: new Map() }; cats.set(s.category, c); }
        let g = c.groups.get(s.group);
        if (!g) { g = { group: s.group, items: [] }; c.groups.set(s.group, g); }
        g.items.push(s);
      }
      return Array.from(cats.values()).map(c => ({
        category: c.category,
        count: Array.from(c.groups.values()).reduce((n, g) => n + g.items.length, 0),
        groups: Array.from(c.groups.values()),
      }));
    },
    schematicCategoryUnlocked(cat) {
      let on = 0, total = 0;
      for (const g of cat.groups) for (const s of g.items) { total++; if (this.effectivePurchased(s.path)) on++; }
      return { on, total };
    },
    setGroupPurchased(items, purchased) {
      for (const s of items) this.setSchematicPurchased(s, purchased);
    },
    toggleProg(cat) { this.progOpen[cat] = !this.progOpen[cat]; },

    // Loaded save name without extension — the basis for save-name defaults.
    originalSaveBase() { return (this.saveStatus?.sourceName ?? 'save').replace(/\.sav$/i, ''); },

    // Baseline (pre-edit) position for a staged edit's target player, in cm.
    _baselinePosition(target) {
      return this.svPlayers?.find(p => p.instanceName === target)?.position ?? null;
    },

    // ── Edit-buffer persistence + undo ────────────────────────────────────
    // localStorage key holding the staged buffer for whichever save it belongs to.
    _EDIT_STORAGE_KEY: 'sl-edit-buffer',

    // Mirror the staged buffer to localStorage, tagged with the loaded save's name
    // so it's only ever restored onto the exact save it was made against (targets
    // are instanceNames, meaningless on a different save). Empty buffer → clear.
    _persistEditBuffer() {
      const id = this.saveStatus?.sourceName;
      try {
        if (!id || this.editCount === 0) { localStorage.removeItem(this._EDIT_STORAGE_KEY); return; }
        localStorage.setItem(this._EDIT_STORAGE_KEY, JSON.stringify({ id, buffer: this.editBuffer }));
      } catch { /* quota exceeded or storage disabled — staging still works in-memory */ }
    },

    // Re-stage a persisted buffer after a reload, but only if it matches the save
    // currently loaded (same sourceName) — otherwise drop it as stale.
    _restoreEditBuffer() {
      if (!this.saveStatus?.loaded) return;
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(this._EDIT_STORAGE_KEY) || 'null'); } catch { /* ignore */ }
      if (!stored || stored.id !== this.saveStatus.sourceName) {
        if (stored) localStorage.removeItem(this._EDIT_STORAGE_KEY); // belongs to another save
        return;
      }
      if (stored.buffer && Object.keys(stored.buffer).length) this.editBuffer = stored.buffer;
    },

    // Undo the most recently staged change (Ctrl/Cmd+Z). _editOrder tracks
    // last-touched order; reverting just drops the key and recomputes.
    undoLastEdit() {
      const key = this._editOrder[this._editOrder.length - 1];
      if (key) this.revertEdit(key);
    },

    // Dismiss the one-time "what's editable" hint on the Save Tools tab.
    dismissEditHint() {
      this.editHintDismissed = true;
      try { localStorage.setItem('sl-edit-hint-dismissed', 'true'); } catch { /* ignore */ }
    },

    // Revert a single staged change — just drop its key (no inverse needed).
    revertEdit(key) {
      const { [key]: _, ...rest } = this.editBuffer;
      this.editBuffer = rest;
      // A reverted teleport must move its marker back; redraw if the map is live.
      if (this.mapInitialized && key.startsWith('player:') && key.endsWith(':position')) {
        this.updateMapMarkers();
      }
    },

    async cancelEdits() {
      if (this.editCount === 0) return;
      const ok = await this.showConfirm({
        title: 'Discard changes',
        message: `Discard <strong class="text-white">${this.editCount}</strong> unsaved change${this.editCount !== 1 ? 's' : ''}?`,
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
      this.editBuffer = {};
      // Redraw map markers so any staged-teleport glow/positions revert to baseline.
      if (this.mapInitialized) this.updateMapMarkers();
    },

    openPersistModal() {
      if (!this.isAdmin) return;
      if (this.editCount === 0) return;
      this.changesModal.show = false;
      this.persistModal = { show: true, saveName: `${this.originalSaveBase()}_edited`, overwrite: false, loading: false, error: null };
    },

    // Toggle the save name between the original (overwrite) and `<name>_edited`.
    setOverwrite(on) {
      this.persistModal.overwrite = on;
      this.persistModal.saveName = on ? this.originalSaveBase() : `${this.originalSaveBase()}_edited`;
    },

    async persistEdits(mode) {
      if (!this.isAdmin) return;
      if (this.editCount === 0) return;
      const saveName = this.persistModal.saveName.trim();
      if (!saveName) { this.persistModal.error = 'Save name is required.'; return; }
      this.persistModal.loading = true;
      this.persistModal.error = null;
      try {
        const edits = this.editList().map(e => ({ kind: e.kind, target: e.target, value: e.value }));
        const result = await api.save.persistEdits({ saveName, mode, edits });
        this.editBuffer = {};
        this.persistModal.show = false;
        // The in-memory save now reflects the edits — resync status + viewer data.
        await this.loadSaveStatus();
        this.clearSvCaches();
        await this.loadSaveActiveSubTab();
        // Persist clears EVERY sv* cache; the map draws players + buildings + nodes
        // + pins, so reload them all (not just players) before redrawing — otherwise
        // those layers redraw from null data and vanish, leaving only player icons.
        if (this.mapInitialized) {
          try {
            await Promise.all([
              this.loadSvPlayers(), this.loadSvResourceNodes(),
              this.loadSvMapPins(), this.loadSvBuildingFootprints(),
            ]);
          } catch { /* ignore */ }
          this.updateMapMarkers();
        }
        if (this.sfStatus.connected) { try { await this.loadSaves(); } catch { /* ignore */ } }
        let message;
        if (result.target === 'mount') {
          message = `Saved "${result.saveName}.sav" to the mounted save directory.`;
        } else if (mode === 'load') {
          message = `Uploaded "${result.saveName}" — the server is now loading it (players reconnect once it's ready).`;
        } else {
          message = `Saved a copy "${result.saveName}" to the server's save list — not loaded (your current save is unchanged).`;
        }
        this.actionResult = { ok: true, message };
      } catch (e) {
        this.persistModal.error = e.message;
      } finally {
        this.persistModal.loading = false;
      }
    },
  };
}
