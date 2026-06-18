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

    // Set one axis from a meters input; stores cm (game units) to match the save.
    setPlayerPositionAxis(player, axis, meters) {
      const cm = Math.round((parseFloat(meters) || 0) * 100);
      const next = { ...this.effectivePosition(player), [axis]: cm };
      const base = player.position;
      const key = this._posKey(player);
      if (next.x === base.x && next.y === base.y && next.z === base.z) {
        // Net-zero vs baseline → drop the override entirely.
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

    editList() { return Object.values(this.editBuffer); },

    // Snap the player's Z to terrain height (+3 m safety) at its current X/Y, so
    // teleporting drops you just above the ground instead of into a mountain/midair.
    async snapToGround(player) {
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
      const W = 280, H = 360, M = 8;
      const vw = window.innerWidth, vh = window.innerHeight;
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

    // Revert a single staged change — just drop its key (no inverse needed).
    revertEdit(key) {
      const { [key]: _, ...rest } = this.editBuffer;
      this.editBuffer = rest;
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
    },

    openPersistModal() {
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
