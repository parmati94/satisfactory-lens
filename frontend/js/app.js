import Alpine from 'alpinejs';
import { api } from './api.js';
import { mapController } from './mapController.js';
import { saveEditing } from './saveEditing.js';

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    // Map tab (Leaflet/Pixi renderer + map state & methods) — see mapController.js.
    ...mapController(),
    // Save-editing methods (edit-buffer overlay + persist) — see saveEditing.js.
    // (Edit state lives below in this object — see the "Save editing" block.)
    ...saveEditing(),
    activeTab: 'dashboard',
    loading: false,
    error: null,

    // App Settings (gear button) — client-side prefs (theme picker, …). Distinct
    // from the Server panel, which lives behind its own header icon now.
    showAppSettings: false,
    theme: 'orange',
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
    actionLoading: false,
    actionResult: null,

    // ── Phase 2: Save Viewer ──────────────────────────────────────────────
    saveStatus: null,
    saveTab: 'players',       // sub-tab: 'players' | 'progression' | 'production' | 'power' | 'storage' | 'structures'
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

      if (this.sfStatus.connected) {
        await this.loadDashboard();
      }
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
      this.error = null;
      this.actionResult = null;
      if (tab === 'dashboard' && !this.serverState && this.sfStatus.connected) await this.loadDashboard();
      if (tab === 'saves' && !this.saves && this.sfStatus.connected) await this.loadSaves();
      if (tab === 'saveviewer') await this.loadSaveActiveSubTab();
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
    // needs, reusing the Save Tools loaders + their cached state (power/buildings/
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
      const pct = this.powerLoadPct();
      return pct > 100 ? 'bg-red-500' : pct > 85 ? 'bg-yellow-500' : 'bg-green-500';
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
      return ms < 80 ? 'text-green-400' : ms < 200 ? 'text-yellow-400' : 'text-red-400';
    },
    // Color tone for tick rate against the 30/s target.
    tickRateTone(r) {
      if (r == null) return 'text-gray-500';
      return r >= 28 ? 'text-green-400' : r >= 20 ? 'text-yellow-400' : 'text-red-400';
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
        if (Object.keys(advancedPayload).length) await api.settings.setAdvanced(advancedPayload);
        this.actionResult = { ok: true, message: 'Server settings applied.' };
        this.settingsEditMode = false; // back to read-only after a successful apply
        await this.loadSettings(); // re-baseline from the server (clears edits)
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

    filteredBuildingCategories() {
      if (!this.svBuildings?.categories) return [];
      const q = this.buildingsSearch.toLowerCase().trim();
      if (!q) return this.svBuildings.categories;
      return this.svBuildings.categories
        .map(cat => ({ ...cat, types: cat.types.filter(b => b.label.toLowerCase().includes(q)) }))
        .filter(cat => cat.types.length > 0);
    },

    // The building categories belong to different intent tabs: Production (crafting +
    // extractors), Power (generators), Storage (its own tab), and Structures (the
    // structural remainder). One computed feeds the three building-list tabs.
    _productionCats: new Set(['Production', 'Miners & Extractors']),
    _powerCats: new Set(['Power']),
    buildingCategoriesForActiveTab() {
      const cats = this.filteredBuildingCategories();
      if (this.saveTab === 'production') return cats.filter(c => this._productionCats.has(c.category));
      if (this.saveTab === 'power')      return cats.filter(c => this._powerCats.has(c.category));
      if (this.saveTab === 'structures') return cats.filter(c =>
        !this._productionCats.has(c.category) && !this._powerCats.has(c.category) && c.category !== 'Storage');
      return [];
    },
    // Display label for a category header within the intent tabs (the data category
    // stays 'Production'/'Power'; only the shown label changes to avoid tab/section clash).
    categoryDisplayLabel(category) {
      if (category === 'Production') return 'Crafting';
      if (category === 'Power') return 'Generators';
      return category;
    },

    // Categories worth drilling into per-instance on the Buildings tab: machines with
    // meaningful per-instance state (recipe/clock) the user might want to locate or
    // edit. Storage is deliberately excluded — the dedicated Storage tab already lists
    // every container with its inventory + edit controls, so a per-instance list here
    // would be redundant; map clicks on a container route straight to the Storage tab.
    // Everything else (foundations, walls, belts…) stays a compact type-count card.
    _instanceableCategories: new Set(['Production', 'Power', 'Miners & Extractors']),
    isInstanceableCategory(category) {
      return this._instanceableCategories.has(category);
    },

    // The full ordered instance list for an expanded type: the rich machine detail
    // (recipe/clock/buffers) once fetched, else the lean position list from the
    // buildings payload. Both carry pos; rich entries add a `kind` + instanceName.
    instanceList(type) {
      return this.machineDetailFor(type.buildClass) || type.instances || [];
    },
    instKey(inst) {
      return inst.instanceName || inst.name || '';
    },
    // Format a production output's throughput, e.g. "40/min" or "12.5 m³/min".
    fmtRate(o) {
      if (!o) return '';
      const n = o.perMin ?? 0;
      const v = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
      return `${v}${o.fluid ? ' m³' : ''}/min`;
    },

    // How many instance rows to render for a type (capped so a 500-constructor type
    // doesn't lag Alpine). "Show more" bumps the cap in INSTANCE_PAGE steps.
    INSTANCE_PAGE: 100,
    visibleInstances(type) {
      const cap = this.buildingInstanceCap[type.typePath] ?? this.INSTANCE_PAGE;
      return this.instanceList(type).slice(0, cap);
    },
    moreInstances(type) {
      this.buildingInstanceCap[type.typePath] =
        (this.buildingInstanceCap[type.typePath] ?? this.INSTANCE_PAGE) + this.INSTANCE_PAGE;
    },
    toggleBuildingType(type) {
      const opening = this.expandedBuildingType !== type.typePath;
      this.expandedBuildingType = opening ? type.typePath : null;
      if (opening) this.loadMachineDetail(type.buildClass);
    },

    // Fetch (and cache) the rich per-instance detail for a machine type — recipe,
    // clock, throughput, buffers. Called when a type is expanded. Types the backend
    // can't model return [] → rows fall back to lean position rows.
    async loadMachineDetail(buildClass) {
      if (this.svMachineDetail[buildClass] || this.machineDetailLoading[buildClass]) return;
      this.machineDetailLoading[buildClass] = true;
      try {
        this.svMachineDetail[buildClass] = await api.save.machineInstances(buildClass);
      } catch (e) {
        this.svMachineDetail[buildClass] = [];
        console.warn('machine detail unavailable:', e.message);
      } finally {
        this.machineDetailLoading[buildClass] = false;
      }
    },

    // The fetched detail for a type, or null if not loaded / empty (→ lean rows).
    machineDetailFor(buildClass) {
      const d = this.svMachineDetail[buildClass];
      return d && d.length ? d : null;
    },

    // Group the flat storage list by container type (buildClass) for the Storage
    // tab's collapsible type sections — mirrors the Buildings tab grouping. Sorted
    // by container count (desc), then label.
    storageGroups() {
      const groups = new Map();
      for (const c of this.svStorage ?? []) {
        let g = groups.get(c.buildClass);
        if (!g) { g = { buildClass: c.buildClass, label: c.label, containers: [] }; groups.set(c.buildClass, g); }
        g.containers.push(c);
      }
      return Array.from(groups.values())
        .sort((a, b) => b.containers.length - a.containers.length || a.label.localeCompare(b.label));
    },

    reloadTooltipText() {
      if (this.newerSaveAvailable && this.newerSaveName) return `Newer save available: ${this.newerSaveName}`;
      if (this.saveStatus?.sourceName) return `Reload ${this.saveStatus.sourceName}`;
      return 'Reload save file';
    },

    async loadSaveStatus() {
      try {
        this.saveStatus = await api.save.status();
        this.newerSaveAvailable = !!this.saveStatus?.newerSaveAvailable;
        this.newerSaveName = this.saveStatus?.newerSaveName ?? null;
      } catch { this.saveStatus = null; }
    },

    // Save Viewer's per-tab data is stale the moment the loaded save changes — clear it
    // all so each sub-tab re-fetches next time it's viewed. Shared by reload, inspect,
    // and the SSE save_reloaded handler so the three stay in sync.
    clearSvCaches() {
      this.svPlayers = null;
      this.svStorage = null;
      this.svBuildings = null;
      this.svPower = null;
      this.svResourceNodes = null;
      this.svMapPins = null;
      this.svBuildingFootprints = null;
      this.svSchematics = null;
      this.expandedBuildingType = null;
      this.highlightedInstanceName = null;
      this.buildingInstanceCap = {};
      this.svMachineDetail = {};
      this.machineDetailLoading = {};
      this.expandedMachine = null;
    },

    // Single reload action (header button) — reloads whatever the active save source
    // resolves to (mount, or latest via the API). The Save Viewer tab's own content area
    // also shows the loading skeleton while it runs, if that tab happens to be active.
    async headerReloadSave() {
      this.headerReloading = true;
      this.saveDataLoading = true;
      try {
        this.saveStatus = await api.save.reload();
        this.newerSaveAvailable = !!this.saveStatus?.newerSaveAvailable;
        this.newerSaveName = this.saveStatus?.newerSaveName ?? null;
        this.clearSvCaches();
        // Refresh saves list so it reflects latest autosave
        if (this.sfStatus.connected) {
          const data = await api.saves.list();
          for (const session of data?.sessions ?? []) {
            session.saveHeaders?.sort((a, b) => b.saveDateTime.localeCompare(a.saveDateTime));
          }
          this.saves = data;
        }
        if (this.saveStatus?.loaded) await this.loadSaveActiveSubTab();
      } catch (e) {
        this.saveDataError = e.message;
      } finally {
        this.headerReloading = false;
        this.saveDataLoading = false;
      }
    },

    // Inspect a specific save in the Save Viewer — the one place this is triggered from is
    // the Saves tab's "Inspect" button. This only loads the save into Lens for viewing; it
    // never touches the live server (that's what "Load to Server" is for).
    async inspectSave(saveName, saveDateTime) {
      this.actionLoading = true;
      this.actionResult = null;
      try {
        // Pass along the saveDateTime we already know from the Saves list, so the backend
        // can keep comparing against it for newer-save polling — otherwise that check has
        // nothing to compare against until the next full reload.
        this.saveStatus = await api.save.download(saveName, saveDateTime);
        this.newerSaveAvailable = !!this.saveStatus?.newerSaveAvailable;
        this.newerSaveName = this.saveStatus?.newerSaveName ?? null;
        this.clearSvCaches();
        await this.switchTab('saveviewer');
      } catch (e) {
        this.actionResult = { ok: false, message: `Failed to load "${saveName}" for inspection: ${e.message}` };
      } finally {
        this.actionLoading = false;
      }
    },

    async switchSaveTab(tab) {
      this.saveTab = tab;
      this.saveDataError = null;
      if (tab !== 'production' && tab !== 'structures') this.buildingsSearch = '';
      await this.loadSaveActiveSubTab();
    },

    async loadSaveActiveSubTab() {
      if (!this.saveStatus?.loaded) return;
      if (this.saveTab === 'players'   && !this.svPlayers)   await this.loadSvPlayers();
      if (this.saveTab === 'storage'   && !this.svStorage)   await this.loadSvStorage();
      // Production / Power / Structures all read the buildings census; Power also
      // needs the circuit summary.
      if (['production', 'power', 'structures'].includes(this.saveTab) && !this.svBuildings) await this.loadSvBuildings();
      if (this.saveTab === 'power'     && !this.svPower)     await this.loadSvPower();
      if (this.saveTab === 'progression' && !this.svSchematics) await this.loadSvSchematics();
    },

    async loadSvSchematics() {
      this.saveDataLoading = true;
      this.saveDataError = null;
      try {
        if (!this.schematicCatalog) this.schematicCatalog = await api.schematicCatalog();
        const data = await api.save.schematics();
        // plain object map (path → true) — Alpine proxies don't play well with Set
        this.svSchematics = Object.fromEntries((data.purchased ?? []).map((p) => [p, true]));
      } catch (e) {
        this.saveDataError = e.message;
      } finally {
        this.saveDataLoading = false;
      }
    },

    async loadSvPlayers() {
      this.saveDataLoading = true;
      this.saveDataError = null;
      try {
        const data = await api.save.players();
        this.svPlayers = data.players;
      } catch (e) {
        this.saveDataError = e.message;
      } finally {
        this.saveDataLoading = false;
      }
    },


    async loadSvStorage() {
      this.saveDataLoading = true;
      this.saveDataError = null;
      try {
        const data = await api.save.storage();
        this.svStorage = data.containers;
      } catch (e) {
        this.saveDataError = e.message;
      } finally {
        this.saveDataLoading = false;
      }
    },

    async loadSvMapPins() {
      try {
        this.svMapPins = await api.save.mapPins();
      } catch (e) {
        console.warn('map pins unavailable:', e.message);
      }
    },

    async loadSvBuildingFootprints() {
      try {
        this.svBuildingFootprints = await api.save.buildingFootprints();
      } catch (e) {
        console.warn('building footprints unavailable:', e.message);
      }
      this._ensureBuildingCategories();
    },

    async loadSvBuildings() {
      this.saveDataLoading = true;
      this.saveDataError = null;
      try {
        this.svBuildings = await api.save.buildings();
      } catch (e) {
        this.saveDataError = e.message;
      } finally {
        this.saveDataLoading = false;
      }
    },


    async loadSvPower() {
      this.saveDataLoading = true;
      this.saveDataError = null;
      try {
        this.svPower = await api.save.power();
      } catch (e) {
        this.saveDataError = e.message;
      } finally {
        this.saveDataLoading = false;
      }
    },

    async loadSvResourceNodes() {
      try {
        this.svResourceNodes = await api.save.resourceNodes();
      } catch { this.svResourceNodes = []; }
      this._ensureNodeTypeFilters();
    },

    connectSaveSSE() {
      if (this._eventSource) return;
      const es = new EventSource('/api/save/events');
      this._eventSource = es;
      es.onopen = () => { this.sseConnected = true; };
      es.onerror = () => { this.sseConnected = false; };
      es.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.event === 'connected') {
            this.newerSaveAvailable = !!msg.newerSaveAvailable;
            this.newerSaveName = msg.newerSaveName ?? null;
          }
          if (msg.event === 'save_available') {
            // The mounted save dir changed (e.g. a new autosave landed). We never
            // auto-reload — that could clobber in-progress edits — just flag it so
            // the user can reload manually when ready.
            this.newerSaveAvailable = !!msg.newerSaveAvailable;
            this.newerSaveName = msg.newerSaveName ?? null;
          }
          if (msg.event === 'save_reloaded') {
            await this.loadSaveStatus();
            this.clearSvCaches();
            if (this.activeTab === 'saveviewer') await this.loadSaveActiveSubTab();
            if (this.activeTab === 'map') {
              await Promise.all([
                this.loadSvPlayers(), this.loadSvResourceNodes(), this.loadSvMapPins(), this.loadSvBuildingFootprints(),
              ]);
              this.updateMapMarkers();
            }
          }
        } catch { /* ignore */ }
      };
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
