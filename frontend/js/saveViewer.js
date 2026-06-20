// Save viewer — the read/display layer for parsed save data: building
// category/instance lists, storage grouping, save status + cache management,
// sub-tab loading, the per-domain loadSv* loaders, and the save-reload SSE.
// Spread into the Alpine 'app' component (`...saveViewer()`) so methods run
// against the shared `this` proxy; all viewer *state* stays in app.js.
import { api } from './api.js';

export function saveViewer() {
  return {
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
        // loadSaveActiveSubTab only refills the Explorer's active sub-tab; if the reload
        // was triggered from the dashboard, repopulate the Factory Snapshot too so it
        // doesn't vanish (clearSvCaches above just nulled its svPower/svBuildings inputs).
        if (this.activeTab === 'dashboard') this.loadFactorySnapshot();
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
      // Inspecting swaps the loaded save (and clears the sv* caches), which would
      // orphan any staged edits — their targets are instanceNames in the current
      // save. Block until the user saves or discards; the save list is also blurred
      // behind a lockout while editing (see saves-tab.html).
      if (this.editCount > 0) {
        this.actionResult = { ok: false, message: 'Finish editing first — save or discard your staged changes before opening another save.' };
        return;
      }
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
        // Surface the Explorer pane: land on the Saves tab and close the mobile drawer.
        this.savesDrawerOpen = false;
        await this.switchTab('saves');
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
            if (this.activeTab === 'saves') await this.loadSaveActiveSubTab();
            // clearSvCaches() just nulled the snapshot inputs (svPower/svBuildings);
            // if we're sitting on the dashboard nothing else will refetch them, so the
            // Factory Snapshot would silently vanish until a tab switch. Repopulate here.
            if (this.activeTab === 'dashboard') this.loadFactorySnapshot();
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
  };
}
