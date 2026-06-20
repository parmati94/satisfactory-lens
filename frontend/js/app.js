import Alpine from 'alpinejs';
import { api } from './api.js';
import { mapController } from './mapController.js';
import { saveEditing } from './saveEditing.js';
import { saveViewer } from './saveViewer.js';

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    // Map tab (Leaflet/Pixi renderer + map state & methods) — see mapController.js.
    ...mapController(),
    // Save-editing methods (edit-buffer overlay + persist) — see saveEditing.js.
    // (Edit state lives below in this object — see the "Save editing" block.)
    ...saveEditing(),
    // Save-viewer read/display + loaders + SSE — see saveViewer.js. (State below.)
    ...saveViewer(),
    activeTab: 'dashboard',
    loading: false,
    error: null,

    // App Settings (gear button) — client-side prefs (theme picker, …). Distinct
    // from the Server panel, which lives behind its own header icon now.
    showAppSettings: false,
    mobileMenuOpen: false,      // mobile (<md) header dropdown panel toggle
    theme: 'orange',
    reduceMotion: false,        // App Settings: dampen animations/transitions
    defaultTab: 'dashboard',    // App Settings: tab opened on load
    themes: [
      { id: 'orange', label: 'Orange', swatch: '#f97316' },
      { id: 'blue', label: 'Blue', swatch: '#3b82f6' },
      { id: 'emerald', label: 'Emerald', swatch: '#10b981' },
      { id: 'violet', label: 'Violet', swatch: '#8b5cf6' },
      { id: 'rose', label: 'Rose', swatch: '#f43f5e' },
    ],

    // App auth (login may be disabled via config — drives the header logout control)
    loginEnabled: false,

    // SF server connection
    sfStatus: { connected: false, host: '', port: 7777 },
    showConnectModal: false,
    connectForm: { host: '', port: 7777, password: '' },
    connectLoading: false,
    connectError: null,

    // Phase 1 tab data
    serverState: null,
    factorySnapshotLoading: false,
    saves: null,
    serverOptions: null,
    advancedSettings: null,
    // Server panel (gear button) — tabbed: 'overview' (live health) | 'config' (editable settings)
    settingsTab: 'overview',
    settingsEditMode: false,   // Configuration tab: false = read-only view, true = editable
    serverHealth: null,        // { latencyMs, ... } from GET /api/server/health
    healthLoading: false,
    settingEdits: {},          // override dict keyed 'server:<key>' / 'advanced:<key>' → new value
    settingsSaving: false,
    newSaveName: '',
    actionLoading: false,      // global mutex: an action is running, disable other action buttons
    creatingSave: false,       // specifically the "Save Now" create flow (drives that button's label)
    actionResult: null,

    // ── Phase 2: Save Viewer ──────────────────────────────────────────────
    saveStatus: null,
    saveTab: 'players',       // sub-tab: 'players' | 'progression' | 'production' | 'power' | 'storage' | 'structures'
    savesDrawerOpen: false,   // <lg only: the save-browser slide-out drawer (Explorer is the default view)
    savesRailCollapsed: false, // lg+ only: collapse the save-browser rail to give the Explorer full width (persisted)
    saveDataLoading: false,
    saveDataError: null,
    svPlayers: null,
    svBuildings: null,
    svPower: null,
    svStorage: null,
    expandedPlayer: null,    // instanceName of expanded player row
    expandedStorage: null,   // instanceName of expanded storage row
    expandedBuildingType: null,   // typePath of expanded building-type row (per-instance list)
    highlightedInstanceName: null,// transient highlight target after a map → instance jump
    buildingInstanceCap: {},      // per-typePath count of how many instance rows to render
    svMachineDetail: {},          // buildClass → fetched per-instance machine detail (on demand)
    machineDetailLoading: {},     // buildClass → bool while its detail is being fetched
    expandedMachine: null,        // instanceName of the machine row whose buffers are expanded
    showSettings: false,
    headerReloading: false,
    confirmDialog: { show: false, title: '', message: '', confirmLabel: 'Confirm', danger: true, resolve: null },
    sseConnected: false,
    _eventSource: null,
    newerSaveAvailable: false,
    newerSaveName: null,
    tooltip: { visible: false, x: 0, y: 0, name: '', count: null, placement: 'top' },
    buildingsSearch: '',
    // ── Save editing (override dictionary over the loaded baseline) ────────
    editBuffer: {},   // key → { kind, target, value, label, changeText }
    persistModal: { show: false, saveName: '', overwrite: false, loading: false, error: null },
    changesModal: { show: false },
    itemCatalog: null, // { itemClass: { path, name, stack } } for the slot picker
    slotEditor: { show: false, invName: '', slot: 0, contextLabel: '', search: '', selClass: '', count: 1, baseline: null, x: 0, y: 0 },
    svSchematics: null,       // baseline purchased set (path → true)
    schematicCatalog: null,   // full progression catalog (array)
    schematicsSearch: '',
    progOpen: {},             // expanded category sections in the Progression tab
    get editCount() { return Object.keys(this.editBuffer).length; },
    // ─────────────────────────────────────────────────────────────────────

    async init() {
      // Apply the saved accent theme before anything paints.
      this.applyTheme(localStorage.getItem('sl-theme') || 'orange');
      // Restore any saved per-category map color overrides.
      this._loadCategoryColors();
      // Restore the saved map filter toggles (fog, players, nodes…) before the
      // map first renders so it opens the way the user last left it.
      this._loadMapFilters();
      // Apply device prefs: reduced motion (seeded from the OS) and landing tab.
      this.applyReduceMotion(this._initialReduceMotion());
      this.loadDefaultTab();

      try {
        const authStatus = await api.auth.status();
        this.loginEnabled = !!authStatus.loginEnabled;
        if (!authStatus.authenticated) {
          window.location.href = '/login.html';
          return;
        }
      } catch { /* login may be disabled */ }

      await this.checkSfStatus();

      // Load save status first so the dashboard's factory snapshot knows whether a
      // save is loaded. Works with a mounted save with no SF connection at all, or
      // via the API once connected (status reflects whichever applies).
      await this.loadSaveStatus();
      this.connectSaveSSE();

      // Open the user's chosen landing tab and trigger its data load.
      await this.switchTab(this.activeTab);
    },

    // Sets the accent theme: flips `data-theme` on <html> (re-tints every
    // accent-* utility) and persists the choice. The map highlight reads the
    // accent live, so it follows on the next hover/focus. Unknown ids → orange.
    applyTheme(id) {
      if (!this.themes.some((t) => t.id === id)) id = 'orange';
      this.theme = id;
      document.documentElement.setAttribute('data-theme', id);
      localStorage.setItem('sl-theme', id);
    },

    // ── App Settings: device-local preferences ────────────────────────────
    // Valid landing tabs (must match the header nav + switchTab keys).
    landingTabs: [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'map', label: 'Map' },
      { id: 'saves', label: 'Saves' },
    ],
    loadDefaultTab() {
      let saved = localStorage.getItem('sl-default-tab');
      // Migrate the retired 'saveviewer' tab — it's now the Explorer pane of 'saves'.
      if (saved === 'saveviewer') { saved = 'saves'; localStorage.setItem('sl-default-tab', 'saves'); }
      this.defaultTab = this.landingTabs.some((t) => t.id === saved) ? saved : 'dashboard';
      this.activeTab = this.defaultTab;
      this.savesRailCollapsed = localStorage.getItem('sl-saves-rail-collapsed') === 'true';
    },
    setDefaultTab(id) {
      if (!this.landingTabs.some((t) => t.id === id)) return;
      this.defaultTab = id;
      localStorage.setItem('sl-default-tab', id);
    },

    // lg+ save-browser rail collapse — defaults open (master-detail norm); once the
    // user collapses it the choice sticks across reloads. No effect below lg, where the
    // rail is the off-canvas drawer (savesDrawerOpen).
    toggleSavesRail() {
      this.savesRailCollapsed = !this.savesRailCollapsed;
      localStorage.setItem('sl-saves-rail-collapsed', String(this.savesRailCollapsed));
    },

    // Reduced motion: off by default; only on when the user explicitly enables it.
    _initialReduceMotion() {
      return localStorage.getItem('sl-reduce-motion') === 'true';
    },
    applyReduceMotion(on) {
      this.reduceMotion = !!on;
      document.documentElement.classList.toggle('reduce-motion', this.reduceMotion);
      localStorage.setItem('sl-reduce-motion', String(this.reduceMotion));
    },
    toggleReduceMotion() { this.applyReduceMotion(!this.reduceMotion); },

    // Count of categories with a custom map color (for the App Settings summary).
    mapColorOverrideCount() { return Object.keys(this.categoryColorOverrides ?? {}).length; },

    // Wipe all device-local prefs back to defaults (theme, map colors, landing
    // tab, reduced motion). Confirmed first — it's a clear-everything action.
    async resetPreferences() {
      const ok = await this.showConfirm({
        title: 'Reset preferences?',
        message: 'Restores the default accent, clears custom map colors, and resets the landing tab, motion settings, and map filters on this device. Your save data is untouched.',
        confirmLabel: 'Reset',
      });
      if (!ok) return;
      ['sl-theme', 'sl-map-colors', 'sl-default-tab', 'sl-reduce-motion', 'sl-map-filters', 'sl-saves-rail-collapsed'].forEach((k) => localStorage.removeItem(k));
      this.applyTheme('orange');
      this.resetAllCategoryColors?.();
      this._resetMapFilters?.();
      this.applyReduceMotion(this._initialReduceMotion());
      this.savesRailCollapsed = false;
      this.setDefaultTab('dashboard');
    },

    async checkSfStatus() {
      try {
        this.sfStatus = await api.sf.status();
        if (this.sfStatus.host) this.connectForm.host = this.sfStatus.host;
        if (this.sfStatus.port) this.connectForm.port = this.sfStatus.port;
      } catch {
        this.sfStatus = { connected: false, host: '', port: 7777 };
      }
    },

    async connectToSF() {
      this.connectLoading = true;
      this.connectError = null;
      try {
        this.sfStatus = await api.sf.connect(
          this.connectForm.host,
          this.connectForm.port,
          this.connectForm.password,
        );
        this.connectForm.password = '';
        this.showConnectModal = false;
        this.serverState = null;
        await this.loadDashboard();
      } catch (e) {
        this.connectError = e.message;
      } finally {
        this.connectLoading = false;
      }
    },

    async disconnect() {
      await api.sf.disconnect();
      this.sfStatus = { connected: false, host: this.sfStatus.host, port: this.sfStatus.port };
      this.serverState = null;
      this.saves = null;
      this.serverOptions = null;
      this.advancedSettings = null;
      this.actionResult = null;
    },

    // Log out of the app UI (distinct from disconnecting the SF server). Only
    // reachable when login is enabled; clears the session cookie then returns to
    // the login page.
    async logout() {
      try { await api.auth.logout(); } catch { /* clear cookie best-effort */ }
      window.location.href = '/login.html';
    },

    async switchTab(tab) {
      this.activeTab = tab;
      this.mobileMenuOpen = false;   // dismiss the mobile header panel on navigation
      this.error = null;
      this.actionResult = null;
      if (tab === 'dashboard' && this.sfStatus.connected) {
        if (!this.serverState) await this.loadDashboard();
        // Explorer navigation (inspecting a save, or visiting a sub-tab that doesn't
        // touch power/buildings) can clear or never-populate the snapshot caches, so
        // refresh them on every dashboard entry — otherwise the Factory Snapshot can
        // silently vanish until a full reload. Cheap + self-guarding when already cached.
        else this.loadFactorySnapshot();
      }
      if (tab === 'saves') {
        if (!this.saves && this.sfStatus.connected) await this.loadSaves();
        // Populate the Explorer pane's active sub-tab when a save is already loaded.
        if (this.saveStatus?.loaded) await this.loadSaveActiveSubTab();
        // On mobile the Explorer is the default view; if nothing's loaded yet, pop the
        // saves drawer so there's something to pick (no-op on lg+, where the rail is fixed).
        else if (window.matchMedia('(max-width: 1023px)').matches) this.savesDrawerOpen = true;
      }
      if (tab === 'map') {
        if (this.saveStatus?.loaded) {
          await Promise.all([
            !this.svPlayers            ? this.loadSvPlayers()            : Promise.resolve(),
            !this.svResourceNodes      ? this.loadSvResourceNodes()      : Promise.resolve(),
            !this.svMapPins            ? this.loadSvMapPins()            : Promise.resolve(),
            !this.svBuildingFootprints ? this.loadSvBuildingFootprints() : Promise.resolve(),
          ]);
        }
        await this.$nextTick();
        this.initMap();
      }
    },

    // ── Phase 1 data loaders ──────────────────────────────────────────────

    async loadDashboard() {
      this.loading = true;
      this.error = null;
      try {
        this.serverState = await api.server.state();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
      // Best-effort factory snapshot from the loaded save (non-blocking, no spinner).
      this.loadFactorySnapshot();
    },

    // Pull the lightweight save-derived stats the dashboard's factory snapshot
    // needs, reusing the Explorer loaders + their cached state (power/buildings/
    // storage/schematics). Skipped entirely when no save is loaded. None of these
    // do per-instance machine fetches, so it stays cheap.
    async loadFactorySnapshot() {
      if (!this.saveStatus?.loaded) return;
      this.factorySnapshotLoading = true;
      try {
        await Promise.all([
          this.svPower      ? null : this.loadSvPower(),
          this.svBuildings  ? null : this.loadSvBuildings(),
          this.svStorage    ? null : this.loadSvStorage(),
          this.svSchematics ? null : this.loadSvSchematics(),
        ]);
      } catch { /* snapshot is best-effort; tabs surface their own errors */ }
      finally { this.factorySnapshotLoading = false; }
    },

    // True once the core snapshot inputs are present.
    factorySnapshotReady() { return !!(this.svPower && this.svBuildings); },

    // Power load as a % of actual production (0 production → 0). >100 means demand
    // exceeds generation (shown red).
    powerLoadPct() {
      const p = this.svPower?.totalProducedMW ?? 0;
      const d = this.svPower?.totalMaxDrawMW ?? 0;
      return p > 0 ? Math.round((d / p) * 100) : 0;
    },
    powerLoadTone() {
      // Normal load uses the (themeable) accent like the progression bar; still
      // escalates to warn/danger as the grid nears/exceeds capacity.
      const pct = this.powerLoadPct();
      return pct > 100 ? 'bg-danger-500' : pct > 85 ? 'bg-warn-500' : 'bg-accent-500';
    },

    // Crafting machines / generators / miners+extractors from the buildings census.
    minersExtractorsCount() {
      const cat = this.svBuildings?.categories?.find(c => c.category === 'Miners & Extractors');
      return cat?.total ?? 0;
    },

    // Progression as % of the catalog's one-time unlocks that are purchased.
    progressionPct() {
      const total = this.schematicCatalog?.length ?? 0;
      if (!total) return 0;
      const have = Object.keys(this.svSchematics ?? {}).length;
      return Math.min(100, Math.round((have / total) * 100));
    },
    progressionCount() { return Object.keys(this.svSchematics ?? {}).length; },

    // The single most recent save across the whole server (by saveDateTime), regardless
    // of which session it's in — distinct from "Loaded" (whatever's in Lens right now).
    globalLatestSaveName() {
      let latest = null;
      for (const session of this.saves?.sessions ?? []) {
        for (const save of session.saveHeaders ?? []) {
          if (!latest || save.saveDateTime > latest.saveDateTime) latest = save;
        }
      }
      return latest?.saveName ?? null;
    },

    async loadSaves() {
      this.loading = true;
      this.error = null;
      try {
        const data = await api.saves.list();
        // Sort each session's saves newest-first (saveDateTime is "YYYY.MM.DD-HH.MM.SS", sorts as string)
        for (const session of data?.sessions ?? []) {
          session.saveHeaders?.sort((a, b) => b.saveDateTime.localeCompare(a.saveDateTime));
        }
        this.saves = data;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    async loadSettings() {
      this.loading = true;
      this.error = null;
      try {
        const [server, advanced] = await Promise.all([
          api.settings.server(),
          api.settings.advanced(),
        ]);
        this.serverOptions = server;
        this.advancedSettings = advanced;
        this.settingEdits = {}; // fresh baseline → drop any stale drafts
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // ── Server panel (gear button) ────────────────────────────────────────
    // Opens the tabbed panel and kicks off both the live health ping and the
    // settings load (only when connected).
    openServerPanel() {
      this.showSettings = true;
      this.settingsTab = 'overview';
      this.settingsEditMode = false; // always open read-only

      if (!this.sfStatus.connected) return;
      this.loadServerHealth();
      if (!this.serverOptions) this.loadSettings();
    },

    // Measured Lens→SF round-trip latency (+ liveness) for the Overview tab.
    async loadServerHealth() {
      this.healthLoading = true;
      try {
        this.serverHealth = await api.server.health();
      } catch {
        this.serverHealth = null; // unreachable → shown as offline in the UI
      } finally {
        this.healthLoading = false;
      }
    },

    // Color tone for the latency readout (green < 80ms, yellow < 200ms, else red).
    latencyTone(ms) {
      if (ms == null) return 'text-gray-500';
      return ms < 80 ? 'text-ok-400' : ms < 200 ? 'text-warn-400' : 'text-danger-400';
    },
    // Color tone for tick rate against the 30/s target.
    tickRateTone(r) {
      if (r == null) return 'text-gray-500';
      return r >= 28 ? 'text-ok-400' : r >= 20 ? 'text-warn-400' : 'text-danger-400';
    },

    // ── Editable settings (Configuration tab) ─────────────────────────────
    // The two SF settings maps are flat string→string. We render each entry as a
    // typed widget inferred from its value (bool/number/text) and humanize the
    // key, rather than hardcoding a key list that drifts across game versions.
    _settingBaseMap(scope) {
      return (scope === 'advanced'
        ? this.advancedSettings?.advancedGameSettings
        : this.serverOptions?.serverOptions) ?? {};
    },
    _settingKey(scope, key) { return `${scope}:${key}`; },

    // True/False (string or bool) → boolean; pure-numeric string → number; else text.
    settingWidgetType(value) {
      const s = String(value).trim().toLowerCase();
      if (s === 'true' || s === 'false') return 'bool';
      if (s !== '' && !isNaN(Number(s))) return 'number';
      return 'text';
    },
    settingIsBool(value) { return String(value).trim().toLowerCase() === 'true'; },

    // "FG.DSS.AutoPause" → "Auto Pause"; "mPlayerLimit" → "Player Limit".
    humanizeSettingKey(key) {
      const tail = String(key).split('.').pop().replace(/^m(?=[A-Z])/, '');
      return tail
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    effectiveSetting(scope, key) {
      const k = this._settingKey(scope, key);
      return k in this.settingEdits ? this.settingEdits[k] : this._settingBaseMap(scope)[key];
    },
    isSettingEdited(scope, key) { return this._settingKey(scope, key) in this.settingEdits; },

    // Set-semantics override; net-zero vs baseline drops the override.
    setSetting(scope, key, value) {
      const k = this._settingKey(scope, key);
      const base = String(this._settingBaseMap(scope)[key]);
      const next = String(value);
      if (next === base) {
        const { [k]: _, ...rest } = this.settingEdits;
        this.settingEdits = rest;
      } else {
        this.settingEdits = { ...this.settingEdits, [k]: next };
      }
    },
    toggleSetting(scope, key) {
      this.setSetting(scope, key, this.settingIsBool(this.effectiveSetting(scope, key)) ? 'False' : 'True');
    },

    // Rows for a scope, sorted by humanized label, carrying widget metadata.
    settingEntries(scope) {
      return Object.keys(this._settingBaseMap(scope))
        .map((key) => {
          const value = this.effectiveSetting(scope, key);
          return { key, scope, value, type: this.settingWidgetType(value),
                   label: this.humanizeSettingKey(key), edited: this.isSettingEdited(scope, key) };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
    },

    settingsDirtyCount() { return Object.keys(this.settingEdits).length; },
    resetSettingDraft() { this.settingEdits = {}; },

    // Apply changed keys, grouped by scope, via the existing PATCH routes.
    async applySettings() {
      const serverPayload = {}, advancedPayload = {};
      for (const [k, v] of Object.entries(this.settingEdits)) {
        const [scope, ...rest] = k.split(':');
        const key = rest.join(':');
        (scope === 'advanced' ? advancedPayload : serverPayload)[key] = v;
      }
      this.settingsSaving = true;
      try {
        if (Object.keys(serverPayload).length) await api.settings.setServer(serverPayload);
        let refused = [];
        if (Object.keys(advancedPayload).length) {
          const result = await api.settings.setAdvanced(advancedPayload);
          refused = result?.refused ?? [];
        }
        this.settingsEditMode = false; // back to read-only after a successful apply
        await this.loadSettings(); // re-baseline from the server (clears edits)
        if (refused.length) {
          // The server accepted the call but kept these as-is — advanced game
          // settings can only be enabled via the API, never disabled. Be honest
          // about it rather than pretending the change stuck.
          const names = refused.map((k) => this.humanizeSettingKey(k)).join(', ');
          this.actionResult = {
            ok: false,
            message: `Applied, but the server kept ${refused.length} setting${refused.length > 1 ? 's' : ''} unchanged: ${names}. ` +
              `Advanced game settings can only be enabled here — to turn one off, use the in-game Esc → Advanced Game Settings menu.`,
          };
        } else {
          this.actionResult = { ok: true, message: 'Server settings applied.' };
        }
      } catch (e) {
        this.actionResult = { ok: false, message: e.message };
      } finally {
        this.settingsSaving = false;
      }
    },

    async triggerSave() {
      const name = this.newSaveName.trim();
      if (!name) return;
      this.actionLoading = true;
      this.creatingSave = true;
      this.actionResult = null;
      try {
        await api.saves.save(name);
        this.actionResult = { ok: true, message: `Saved as "${name}"` };
        this.newSaveName = '';
        this.saves = null;
        await this.loadSaves();
      } catch (e) {
        this.actionResult = { ok: false, message: e.message };
      } finally {
        this.actionLoading = false;
        this.creatingSave = false;
      }
    },

    async deleteSave(saveName, saveDateTime) {
      const ok = await this.showConfirm({
        title: 'Delete Save',
        message: `Permanently delete <strong class="text-white">${saveName}</strong>?${saveDateTime ? `<br><span class="text-gray-500 text-xs">${this.formatSaveDate(saveDateTime)}</span>` : ''}<br><br>This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      this.actionLoading = true;
      this.actionResult = null;
      try {
        await api.saves.delete(saveName);
        this.actionResult = { ok: true, message: `"${saveName}" deleted.` };
        const data = await api.saves.list();
        for (const session of data?.sessions ?? []) {
          session.saveHeaders?.sort((a, b) => b.saveDateTime.localeCompare(a.saveDateTime));
        }
        this.saves = data;
      } catch (e) {
        this.actionResult = { ok: false, message: e.message };
      } finally {
        this.actionLoading = false;
      }
    },

    async loadSave(sessionName, saveName) {
      const ok = await this.showConfirm({
        title: 'Load to Server',
        message: `Switch the live server to <strong class="text-white">${saveName}</strong>? Connected players will be disconnected while it loads. This only affects the server — it won't change anything in the Save Viewer.`,
        confirmLabel: 'Load to Server',
        danger: true,
      });
      if (!ok) return;
      this.actionLoading = true;
      this.actionResult = null;
      try {
        await api.saves.load(sessionName, saveName);
        this.actionResult = { ok: true, message: `Loading "${saveName}"… Server is switching saves.` };
        setTimeout(() => { this.serverState = null; this.loadDashboard(); }, 5000);
      } catch (e) {
        this.actionResult = { ok: false, message: e.message };
      } finally {
        this.actionLoading = false;
      }
    },

    // ── Phase 2: Save Viewer methods ──────────────────────────────────────

    storagePreview(contents, max = 4) {
      const byClass = {};
      for (const item of contents) {
        if (!byClass[item.itemClass]) byClass[item.itemClass] = { ...item, count: 0 };
        byClass[item.itemClass].count += item.count;
      }
      const unique = Object.values(byClass).sort((a, b) => b.count - a.count);
      return { items: unique.slice(0, max), overflow: Math.max(0, unique.length - max) };
    },

    slotGrid(contents, totalSlots) {
      if (!totalSlots) return [];
      const bySlot = {};
      for (const item of contents) bySlot[item.slotIndex] = item;
      return Array.from({ length: totalSlots }, (_, i) => bySlot[i] ?? null);
    },

    showTooltip(event, name, count = null, placement = 'top') {
      const rect = event.currentTarget.getBoundingClientRect();
      // 'top' (default) anchors above the element — good for elements with room above it.
      // 'bottom' anchors below — use for elements near the top of the viewport (e.g. header).
      const y = placement === 'bottom' ? rect.bottom : rect.top;
      const x = rect.left + rect.width / 2;
      this.tooltip = { visible: true, x, y, name, count, placement };
      // Tooltip is centered on `x`, but long text can overflow the viewport on narrow
      // windows — nudge it back on-screen once we know its actual rendered width.
      this.$nextTick(() => {
        const el = this.$refs.tooltipBox;
        if (!el) return;
        const margin = 8;
        const halfWidth = el.offsetWidth / 2;
        const vw = window.innerWidth;
        let clampedX = x;
        if (clampedX - halfWidth < margin) clampedX = halfWidth + margin;
        if (clampedX + halfWidth > vw - margin) clampedX = vw - margin - halfWidth;
        this.tooltip.x = clampedX;
      });
    },

    hideTooltip() {
      this.tooltip.visible = false;
    },

    showItemTooltip(event, item) {
      if (!item) return;
      this.showTooltip(event, item.displayName, item.count);
    },

    reloadTooltipText() {
      if (this.newerSaveAvailable && this.newerSaveName) return `Newer save available: ${this.newerSaveName}`;
      if (this.saveStatus?.sourceName) return `Reload ${this.saveStatus.sourceName}`;
      return 'Reload save file';
    },

    formatSaveDate(dt) {
      if (!dt) return '';
      // SF API returns saveDateTime as "YYYY.MM.DD-HH.MM.SS"
      const m = String(dt).match(/^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/);
      if (!m) return String(dt);
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
      return isNaN(d.getTime()) ? String(dt) : d.toLocaleString();
    },

    showConfirm({ title, message, confirmLabel = 'Confirm', danger = true }) {
      return new Promise(resolve => {
        this.confirmDialog = { show: true, title, message, confirmLabel, danger, resolve };
      });
    },
    confirmDialogAccept() {
      this.confirmDialog.resolve?.(true);
      this.confirmDialog.show = false;
    },
    confirmDialogCancel() {
      this.confirmDialog.resolve?.(false);
      this.confirmDialog.show = false;
    },

    formatCoord(n) {
      return `${(n / 100).toFixed(0)} m`;
    },

    formatDuration(seconds) {
      if (!seconds) return '—';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    },

    formatUEPath(path) {
      if (!path || path === 'None' || path === '') return '—';
      const clean = path.replace(/'/g, '');
      const lastDot = clean.lastIndexOf('.');
      const segment = lastDot >= 0 ? clean.slice(lastDot + 1) : (clean.split('/').pop() ?? clean);
      const stripped = segment.replace(/^[A-Z]{2,3}_/, '');
      return stripped.replace(/_/g, ' ') || '—';
    },
  }));
});

Alpine.start();
