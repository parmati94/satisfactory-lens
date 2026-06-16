import Alpine from 'alpinejs';
import { api } from './api.js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Stored outside Alpine to avoid reactivity overhead on Leaflet objects
let _leafletMap = null;
let _playerLayer = null;
let _resourceNodeLayer = null;
let _mapPinLayer = null;
let _buildingOverlay = null;
let _buildingOverlayContainer = null;
let _buildingHitList = [];
let _lastHoverMs = 0;
// Hover outline is drawn as a PIXI.Graphics inside the building overlay (the
// overlayPane, z-index 400) rather than a separate HTML canvas, so the Leaflet
// tooltipPane (650) naturally renders above it and PIXI handles all pan/zoom
// reprojection. _pixiUtils/_unitsPerCm are captured at sprite-rebuild time so
// the outline shares the sprites' coordinate space.
let _highlightGfx = null;
let _pixiUtils = null;
let _unitsPerCm = 1;

// Building hover tooltip — a Leaflet tooltip rather than our own DOM/Alpine
// element. Leaflet renders it into the tooltipPane, which it always stacks above
// the tile and PIXI overlay panes, so the WebGL canvas can never obscure it
// (the same reason the marker bindPopup() tooltips are never covered). Anchored
// to the hovered building's centre, like a marker popup anchors to its marker.
let _buildingTooltip = null;
let _hoveredBuilding = null;

// pixi.js + leaflet-pixi-overlay add ~500KB — only users who open the Map tab
// should pay for the WebGL building-footprint renderer, so load it lazily.
let _PIXI = null;
async function loadPixiDeps() {
  if (_PIXI) return _PIXI;
  const [PIXI] = await Promise.all([
    import('pixi.js'),
    import('leaflet-pixi-overlay'),
  ]);
  _PIXI = PIXI;
  return _PIXI;
}

// Satisfactory world bounds in Unreal cm
const MAP_WEST  = -324698.832031;
const MAP_EAST  =  425301.832031;
const MAP_NORTH = -375000;
const MAP_SOUTH =  375000;
const TILE_SIZE = 256;

// Local tiles are cropped to the exact game world — no padding.
// 16384px canvas / 256px tiles = 64 tiles per side at native zoom 6.
const MAP_BG_SIZE    = 16384;
const MAP_W          = MAP_WEST;
const MAP_N          = MAP_NORTH;
const MAP_X_MAX      = Math.abs(MAP_WEST) + Math.abs(MAP_EAST);
const MAP_Y_MAX      = Math.abs(MAP_NORTH) + Math.abs(MAP_SOUTH);
const MAP_ZOOM_RATIO = Math.round(Math.log2(MAP_BG_SIZE / TILE_SIZE)); // 6


function gameToLatLng(gameX, gameY) {
  const rasterX = (gameX - MAP_W) * MAP_BG_SIZE / MAP_X_MAX;
  const rasterY = (gameY - MAP_N) * MAP_BG_SIZE / MAP_Y_MAX;
  return _leafletMap.unproject([rasterX, rasterY], MAP_ZOOM_RATIO);
}

function latLngToGame(latlng) {
  const p = _leafletMap.project(latlng, MAP_ZOOM_RATIO);
  return { x: p.x * MAP_X_MAX / MAP_BG_SIZE + MAP_W, y: p.y * MAP_Y_MAX / MAP_BG_SIZE + MAP_N };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    activeTab: 'dashboard',
    loading: false,
    error: null,

    // SF server connection
    sfStatus: { connected: false, host: '', port: 7777 },
    showConnectModal: false,
    connectForm: { host: '', port: 7777, password: '' },
    connectLoading: false,
    connectError: null,

    // Phase 1 tab data
    serverState: null,
    saves: null,
    serverOptions: null,
    advancedSettings: null,
    newSaveName: '',
    actionLoading: false,
    actionResult: null,

    // ── Phase 3: Map ─────────────────────────────────────────────────────
    mapInitialized: false,
    svResourceNodes: null,
    mapRefreshing: false,
    mapFiltersOpen: false,
    mapFilters: {
      players:       true,
      hub:           true,
      stamps:        true,
      buildings:     true,
      purityImpure:  true,
      purityNormal:  true,
      purityPure:    true,
    },
    svMapPins: null,
    svBuildingFootprints: null,
    // ─────────────────────────────────────────────────────────────────────

    // ── Phase 2: Save Viewer ──────────────────────────────────────────────
    saveStatus: null,
    saveTab: 'players',       // sub-tab within save viewer: 'players' | 'buildings' | 'resources' | 'power'
    saveDataLoading: false,
    saveDataError: null,
    svPlayers: null,
    svBuildings: null,
    svResources: null,
    svPower: null,
    svStorage: null,
    expandedPlayer: null,    // instanceName of expanded player row
    expandedStorage: null,   // instanceName of expanded storage row
    showSettings: false,
    headerReloading: false,
    confirmDialog: { show: false, title: '', message: '', confirmLabel: 'Confirm', danger: true, resolve: null },
    sseConnected: false,
    _eventSource: null,
    newerSaveAvailable: false,
    newerSaveName: null,
    tooltip: { visible: false, x: 0, y: 0, name: '', count: null, placement: 'top' },
    buildingsSearch: '',
    // ─────────────────────────────────────────────────────────────────────

    async init() {
      try {
        const authStatus = await api.auth.status();
        if (!authStatus.authenticated) {
          window.location.href = '/login.html';
          return;
        }
      } catch { /* login may be disabled */ }

      await this.checkSfStatus();
      if (this.sfStatus.connected) {
        await this.loadDashboard();
      }

      // Always load save status and connect SSE — works with a mounted save with no SF
      // connection at all, or via the API once connected (status reflects whichever applies)
      await this.loadSaveStatus();
      this.connectSaveSSE();
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
    },

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
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
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
      this.svResources = null;
      this.svPower = null;
      this.svResourceNodes = null;
      this.svMapPins = null;
      this.svBuildingFootprints = null;
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
      if (tab !== 'buildings') this.buildingsSearch = '';
      await this.loadSaveActiveSubTab();
    },

    async loadSaveActiveSubTab() {
      if (!this.saveStatus?.loaded) return;
      if (this.saveTab === 'players'   && !this.svPlayers)   await this.loadSvPlayers();
      if (this.saveTab === 'storage'   && !this.svStorage)   await this.loadSvStorage();
      if (this.saveTab === 'buildings' && !this.svBuildings) await this.loadSvBuildings();
      if (this.saveTab === 'resources' && !this.svResources) await this.loadSvResources();
      if (this.saveTab === 'power'     && !this.svPower)     await this.loadSvPower();
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

    async loadSvResources() {
      this.saveDataLoading = true;
      this.saveDataError = null;
      try {
        this.svResources = await api.save.resources();
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

    // ── Phase 3: Map methods ──────────────────────────────────────────────

    toggleMapFilters() {
      this.mapFiltersOpen = !this.mapFiltersOpen;
    },

    toggleMapFilter(key) {
      this.mapFilters[key] = !this.mapFilters[key];
      this.updateMapMarkers();
    },

    toggleAllNodes() {
      const anyOn = this.mapFilters.purityImpure || this.mapFilters.purityNormal || this.mapFilters.purityPure;
      this.mapFilters.purityImpure = !anyOn;
      this.mapFilters.purityNormal = !anyOn;
      this.mapFilters.purityPure   = !anyOn;
      this.updateMapMarkers();
    },

    nodeCountByPurity(purity) {
      return this.svResourceNodes?.filter(n => n.purity === purity && n.icon).length ?? 0;
    },

    mapResetView() {
      if (!_leafletMap) return;
      const bounds = L.latLngBounds(
        gameToLatLng(MAP_WEST, MAP_NORTH),
        gameToLatLng(MAP_EAST, MAP_SOUTH),
      );
      _leafletMap.setView(bounds.getCenter(), _leafletMap.getBoundsZoom(bounds) + 1.75, { animate: true });
    },

    async mapRefresh() {
      if (this.mapRefreshing || !this.saveStatus?.loaded) return;
      this.mapRefreshing = true;
      try {
        await Promise.all([
          this.loadSvPlayers(), this.loadSvResourceNodes(), this.loadSvMapPins(), this.loadSvBuildingFootprints(),
        ]);
        this.updateMapMarkers();
      } finally {
        setTimeout(() => { this.mapRefreshing = false; }, 400);
      }
    },

    mapZoomIn()  { _leafletMap?.zoomIn(); },
    mapZoomOut() { _leafletMap?.zoomOut(); },

    initMap() {
      if (_leafletMap) {
        _leafletMap.invalidateSize();
        this.ensureBuildingOverlay();
        this.updateMapMarkers();
        return;
      }

      const container = document.getElementById('leaflet-map');
      _leafletMap = L.map(container, {
        crs: L.CRS.Simple,
        minZoom: 1,
        maxZoom: 12,
        zoomSnap: 0.25,
        zoomDelta: 0.25,
        zoomControl: false,
      });

      // Bounds of the playable world (the un-padded map), expressed via the same
      // game→latLng mapping the markers use, so tiles, panning limits and markers
      // all share one coordinate system. This excludes SCIM's gray border, so
      // those border tiles are never requested.
      const bounds = L.latLngBounds(
        gameToLatLng(MAP_WEST, MAP_NORTH),
        gameToLatLng(MAP_EAST, MAP_SOUTH),
      );

      _leafletMap.setMaxBounds(bounds);
      _leafletMap.options.maxBoundsViscosity = 1.0;

      L.tileLayer('/tiles/{z}/{x}/{y}.png', {
        noWrap: true,
        bounds,
        minNativeZoom: 3,
        maxNativeZoom: MAP_ZOOM_RATIO,
        maxZoom: 10,
        tileSize: TILE_SIZE,
      }).addTo(_leafletMap);

      // Layer z-order: buildings (WebGL, overlayPane) → nodes → pins → players
      this.ensureBuildingOverlay();
      _resourceNodeLayer = L.layerGroup().addTo(_leafletMap);
      _mapPinLayer       = L.layerGroup().addTo(_leafletMap);
      _playerLayer       = L.layerGroup().addTo(_leafletMap);

      const mapEl = document.getElementById('leaflet-map');

      // Reusable Leaflet tooltip for building hover — lives in the tooltipPane,
      // so it's always layered above the PIXI overlay. interactive:false keeps it
      // from stealing pointer events that drive the hover detection.
      _buildingTooltip = L.tooltip({
        direction: 'top',
        offset: [0, -6],
        opacity: 1,
        interactive: false,
        className: 'sf-building-tooltip',
      });

      // Native mousemove fires regardless of whether PIXI canvas absorbed the event.
      mapEl.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - _lastHoverMs < 16) return;
        _lastHoverMs = now;
        const cp = _leafletMap.mouseEventToContainerPoint(e);
        const latlng = _leafletMap.containerPointToLatLng(cp);
        this._handleBuildingHover(latlng);
      });
      mapEl.addEventListener('mouseleave', () => {
        this._endBuildingHover(mapEl);
      });

      const center = bounds.getCenter();
      const frameView = () => {
        const fitZoom = _leafletMap.getBoundsZoom(bounds);
        _leafletMap.setView(center, fitZoom + 2, { animate: false });
      };

      frameView();

      new ResizeObserver(() => {
        if (_leafletMap) _leafletMap.invalidateSize({ animate: false });
      }).observe(container);

      requestAnimationFrame(() => {
        if (!_leafletMap) return;
        _leafletMap.invalidateSize({ animate: false });
        frameView();
      });

      this.mapInitialized = true;
      this.updateMapMarkers();
    },

    updateMapMarkers() {
      if (!_leafletMap) return;
      this._updateBuildingFootprints();
      this._updatePlayerMarkers();
      this._updateMapPinMarkers();
      this._updateResourceNodeMarkers();
    },

    // Lazy-loads Pixi and creates the WebGL building-footprint overlay (once per
    // map instance). The draw callback handles everything from then on: rebuilding
    // sprites when svBuildingFootprints changes, and applying the filter/zoom LOD
    // visibility check — both on Leaflet's own zoom-triggered redraws and on our
    // explicit ones via _updateBuildingFootprints().
    async ensureBuildingOverlay() {
      if (_buildingOverlay || !_leafletMap) return;
      const PIXI = await loadPixiDeps();
      if (!_leafletMap) return; // map was torn down while Pixi was loading

      const container = new PIXI.Container();
      _buildingOverlayContainer = container;
      // Persistent outline graphic, kept as the top-most child so it draws over
      // the sprites. Created once; survives sprite rebuilds (see _rebuildBuildingSprites).
      _highlightGfx = new PIXI.Graphics();
      let builtForData = null;

      _buildingOverlay = L.pixiOverlay((utils) => {
        _pixiUtils = utils;
        const data = this.svBuildingFootprints;
        if (data !== builtForData) {
          this._rebuildBuildingSprites(PIXI, container, utils, data);
          builtForData = data;
        }

        container.visible = !!this.mapFilters.buildings && !!data;
        container.addChild(_highlightGfx); // re-assert top of z-order each draw

        utils.getRenderer().render(container);
      }, container);

      _buildingOverlay.addTo(_leafletMap);
      this._updateBuildingFootprints();
    },

    // Triggers a redraw of the building overlay (re-runs the draw callback above).
    // Safe to call before the overlay exists yet — ensureBuildingOverlay() catches
    // up once Pixi finishes loading.
    _updateBuildingFootprints() {
      _buildingOverlay?.redraw();
    },

    // Rebuilds every building sprite from scratch. Only called when the underlying
    // data actually changes (new save loaded/reloaded) — not on every redraw — since
    // positions are static between loads and the overlay handles zoom/pan scaling
    // on its own (see Leaflet.PixiOverlay's "no need to reproject on zoom" design).
    _rebuildBuildingSprites(PIXI, container, utils, data) {
      // Tear down old sprites but keep the persistent highlight graphic alive.
      for (const child of container.removeChildren()) {
        if (child !== _highlightGfx) child.destroy();
      }
      _highlightGfx?.clear();
      _buildingHitList = [];
      if (!data?.x?.length) return;

      // Game-cm → overlay layer-point is a fixed linear scale (CRS.Simple and our
      // gameToLatLng mapping are both pure linear transforms) — compute it once
      // from two reference points rather than reprojecting per building.
      const p0 = utils.latLngToLayerPoint(gameToLatLng(0, 0));
      const p1 = utils.latLngToLayerPoint(gameToLatLng(1000, 0));
      const unitsPerCm = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 1000;
      _unitsPerCm = unitsPerCm;

      for (const type of data.types) {
        if (type._tint === undefined) type._tint = parseInt(type.color.slice(1), 16);
      }

      const categoryLayers = new Map();
      const categoryContainer = (category) => {
        let layer = categoryLayers.get(category);
        if (!layer) {
          layer = new PIXI.Container();
          categoryLayers.set(category, layer);
          container.addChild(layer);
        }
        return layer;
      };

      // Shrink each sprite relative to its true footprint so the dark map
      // background bleeds through as a visible gap between adjacent buildings.
      // The hit list still uses the full footprint for a generous hover area.
      const GAP_CM = 25;      // gap per side in game-cm
      const MIN_RATIO = 0.65; // never shrink below 65 % of the original dimension

      // Structural/passive categories: very numerous and sit flat on the ground,
      // so their 2-D footprints would block hover access to machines above them.
      const SKIP_HIT_CATEGORIES = new Set([
        'Foundations', 'Walls', 'Ramps', 'Stairs & Walkways', 'Roofs & Pillars',
      ]);

      for (let i = 0; i < data.x.length; i++) {
        const type = data.types[data.typeIndex[i]];
        const yaw = data.yaw[i];
        const fp = type.footprint;

        // Rotate the footprint's local-space offset by yaw before adding to world pos.
        const cos = Math.cos(yaw), sin = Math.sin(yaw);
        const worldX = data.x[i] + fp.offsetX * cos - fp.offsetY * sin;
        const worldY = data.y[i] + fp.offsetX * sin + fp.offsetY * cos;
        const point = utils.latLngToLayerPoint(gameToLatLng(worldX, worldY));

        const fillW = Math.max(fp.width - GAP_CM * 2, fp.width * MIN_RATIO);
        const fillH = Math.max(fp.depth - GAP_CM * 2, fp.depth * MIN_RATIO);

        const sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
        sprite.anchor.set(0.5);
        sprite.tint = type._tint;
        sprite.alpha = 0.88;
        sprite.x = point.x;
        sprite.y = point.y;
        sprite.width = Math.max(fillW * unitsPerCm, 1);
        sprite.height = Math.max(fillH * unitsPerCm, 1);
        sprite.rotation = yaw;

        categoryContainer(type.category).addChild(sprite);

        // Full footprint for hit testing — generous hover area even for thin belts/pipes.
        // Skip structural categories: they're numerous, uninteresting, and their
        // large 2-D footprints would block hover access to machines sitting on top.
        if (!SKIP_HIT_CATEGORIES.has(type.category)) {
          const hw = fp.width / 2;
          const hh = fp.depth / 2;
          _buildingHitList.push({
            cx: worldX, cy: worldY, hw, hh, cos, sin,
            // Layer-point centre + yaw for drawing the outline in the overlay's
            // (rebuild-zoom) coordinate space, matching how the sprite is placed.
            lpx: point.x, lpy: point.y, yaw,
            aabbHW: hw * Math.abs(cos) + hh * Math.abs(sin),
            aabbHH: hw * Math.abs(sin) + hh * Math.abs(cos),
            label: type.label,
            buildClass: type.buildClass,
            category: type.category,
          });
        }
      }
    },

    _handleBuildingHover(latlng) {
      const mapEl = document.getElementById('leaflet-map');
      if (!this.mapFilters.buildings || !_buildingHitList.length) {
        this._endBuildingHover(mapEl);
        return;
      }

      const { x: mx, y: my } = latLngToGame(latlng);

      for (const b of _buildingHitList) {
        const dx = mx - b.cx, dy = my - b.cy;
        if (Math.abs(dx) > b.aabbHW || Math.abs(dy) > b.aabbHH) continue;
        const lx = dx * b.cos + dy * b.sin;
        const ly = -dx * b.sin + dy * b.cos;
        if (Math.abs(lx) <= b.hw && Math.abs(ly) <= b.hh) {
          // Tooltip tracks the cursor for a smooth follow; only refill its content
          // and redraw the outline when the hovered building actually changes.
          _buildingTooltip.setLatLng(latlng);
          if (b !== _hoveredBuilding) {
            _hoveredBuilding = b;
            _buildingTooltip.setContent(this._buildingTooltipHtml(b));
            if (!_leafletMap.hasLayer(_buildingTooltip)) {
              _leafletMap.openTooltip(_buildingTooltip);
            }
            this._drawBuildingHighlight(b);
          }
          mapEl.style.cursor = 'pointer';
          return;
        }
      }

      this._endBuildingHover(mapEl);
    },

    // Tear down all hover affordances (tooltip, outline, cursor) in one place.
    _endBuildingHover(mapEl) {
      if (_hoveredBuilding) {
        _hoveredBuilding = null;
        if (_buildingTooltip) _leafletMap?.closeTooltip(_buildingTooltip);
        this._clearBuildingHighlight();
      }
      if (mapEl) mapEl.style.cursor = '';
    },

    _buildingTooltipHtml(b) {
      return `<div class="sf-btt">
        <img class="sf-btt-img" src="/assets/buildings/${b.buildClass}.png" onerror="this.style.display='none'">
        <div class="sf-btt-text">
          <p class="sf-btt-label">${b.label}</p>
          <p class="sf-btt-cat">${b.category}</p>
        </div>
      </div>`;
    },

    // Draws the orange outline as a rotated rect in the overlay's coordinate
    // space (same placement maths as the sprite: layer-point centre + yaw), so
    // it pans and zooms with the buildings without per-frame redraws. The line
    // width is divided by the container scale to stay ~constant on screen.
    _drawBuildingHighlight(b) {
      const g = _highlightGfx;
      if (!g || !_buildingOverlayContainer) return;
      const scale = _buildingOverlayContainer.scale.x || 1;
      const w = b.hw * 2 * _unitsPerCm;
      const h = b.hh * 2 * _unitsPerCm;
      g.clear();
      g.position.set(b.lpx, b.lpy);
      g.rotation = b.yaw;
      // Soft outer glow, then the crisp 2px line.
      g.lineStyle((6 / scale), 0xf97316, 0.25);
      g.drawRect(-w / 2, -h / 2, w, h);
      g.lineStyle((2 / scale), 0xf97316, 1);
      g.drawRect(-w / 2, -h / 2, w, h);
      _buildingOverlay?.redraw();
    },

    _clearBuildingHighlight() {
      if (_highlightGfx) {
        _highlightGfx.clear();
        _buildingOverlay?.redraw();
      }
    },

    _updatePlayerMarkers() {
      if (!_playerLayer) return;
      _playerLayer.clearLayers();
      if (!this.mapFilters.players || !this.svPlayers?.length) return;

      for (const player of this.svPlayers) {
        const latlng = gameToLatLng(player.position.x, player.position.y);
        const xM = (player.position.x / 100).toFixed(0);
        const yM = (player.position.y / 100).toFixed(0);
        const zM = (player.position.z / 100).toFixed(0);
        const icon = L.icon({
          iconUrl: '/assets/players/player_marker.png',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          popupAnchor: [0, -14],
        });
        L.marker(latlng, { icon })
          .bindPopup(`<strong>${player.playerName}</strong><br><span style="font-family:monospace;font-size:11px">${xM} m, ${yM} m, ${zM} m alt</span>`)
          .addTo(_playerLayer);
      }
    },

    _updateMapPinMarkers() {
      if (!_mapPinLayer) return;
      _mapPinLayer.clearLayers();
      if (!this.svMapPins) return;

      // HUB — dark blue circle with inline SVG house icon, slightly larger than other markers
      if (this.mapFilters.hub && this.svMapPins.hub) {
        const hub = this.svMapPins.hub;
        const latlng = gameToLatLng(hub.position.x, hub.position.y);
        const icon = L.divIcon({
          className: '',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
          popupAnchor: [0, -18],
          html: `<div style="width:32px;height:32px;border-radius:50%;background:#1e3a8a;border:2px solid white;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.6)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
            </svg>
          </div>`,
        });
        L.marker(latlng, { icon })
          .bindPopup('<strong>HUB Terminal</strong>')
          .addTo(_mapPinLayer);
      }

      // Player-placed map stamps
      if (this.mapFilters.stamps && this.svMapPins.stamps?.length) {
        for (const stamp of this.svMapPins.stamps) {
          const latlng = gameToLatLng(stamp.position.x, stamp.position.y);
          const { r, g, b } = stamp.color;
          const cssColor = `rgb(${r},${g},${b})`;
          const icon = L.divIcon({
            className: '',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -16],
            html: `<div style="width:28px;height:28px;border-radius:50%;background:${cssColor};border:2px solid white;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.6)">
              <svg width="13" height="15" viewBox="0 0 16 18" fill="white" xmlns="http://www.w3.org/2000/svg">
                <ellipse cx="8" cy="7" rx="6" ry="6"/>
                <ellipse cx="8" cy="7" rx="2.5" ry="2.5" fill="${cssColor}"/>
                <polygon points="3,10 13,10 8,18"/>
              </svg>
            </div>`,
          });
          const label = stamp.name || 'Map Marker';
          L.marker(latlng, { icon })
            .bindPopup(`<strong>${label}</strong>`)
            .addTo(_mapPinLayer);
        }
      }
    },

    _updateResourceNodeMarkers() {
      if (!_resourceNodeLayer) return;
      _resourceNodeLayer.clearLayers();
      const anyNodesOn = this.mapFilters.purityImpure || this.mapFilters.purityNormal || this.mapFilters.purityPure;
      if (!anyNodesOn || !this.svResourceNodes?.length) return;

      const PURITY_RING = { Impure: '#ef4444', Normal: '#eab308', Pure: '#22c55e', Unknown: '#6b7280' };

      for (const node of this.svResourceNodes) {
        if (!node.icon) continue;
        if (!this.mapFilters[`purity${node.purity}`]) continue;
        const latlng = gameToLatLng(node.position.x, node.position.y);
        const ring = PURITY_RING[node.purity] ?? PURITY_RING.Unknown;

        const icon = L.divIcon({
          className: '',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          html: `<div style="width:28px;height:28px;border-radius:50%;border:2.5px solid ${ring};overflow:hidden;background:#111827;box-shadow:0 1px 3px rgba(0,0,0,.6)"><img src="/assets/resources/${node.icon}" style="width:100%;height:100%;object-fit:cover"></div>`,
        });

        const xM = (node.position.x / 100).toFixed(0);
        const yM = (node.position.y / 100).toFixed(0);
        L.marker(latlng, { icon })
          .bindPopup(`<strong>${node.label}</strong><br><span style="color:${ring};font-size:11px">${node.purity}</span><br><span style="font-family:monospace;font-size:11px">${xM} m, ${yM} m</span>`)
          .addTo(_resourceNodeLayer);
      }
    },

    // ─────────────────────────────────────────────────────────────────────

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
