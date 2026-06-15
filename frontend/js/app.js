import Alpine from 'alpinejs';
import { api } from './api.js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Stored outside Alpine to avoid reactivity overhead on Leaflet objects
let _leafletMap = null;
let _playerLayer = null;
let _resourceNodeLayer = null;

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
      purityImpure:  true,
      purityNormal:  true,
      purityPure:    true,
    },
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
    showDownloadModal: false,
    downloadSaveName: '',
    downloadLoading: false,
    downloadError: null,
    sseConnected: false,
    _eventSource: null,
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

      // Always load save status and connect SSE (save viewer works independently of SF connection)
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
      if (tab === 'settings' && !this.serverOptions && this.sfStatus.connected) await this.loadSettings();
      if (tab === 'saveviewer') await this.loadSaveActiveSubTab();
      if (tab === 'map') {
        if (this.saveStatus?.loaded) {
          await Promise.all([
            !this.svPlayers       ? this.loadSvPlayers()       : Promise.resolve(),
            !this.svResourceNodes ? this.loadSvResourceNodes() : Promise.resolve(),
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

    async loadSaves() {
      this.loading = true;
      this.error = null;
      try {
        this.saves = await api.saves.list();
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

    async loadSave(sessionName, saveName) {
      if (!confirm(`Load "${saveName}"?\n\nThe server will switch to this save. Connected players will be disconnected.`)) return;
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

    async loadSaveStatus() {
      try {
        this.saveStatus = await api.save.status();
      } catch { this.saveStatus = null; }
    },

    async reloadSave() {
      this.saveDataLoading = true;
      try {
        this.saveStatus = await api.save.reload();
        this.svPlayers = null;
        this.svBuildings = null;
        this.svResources = null;
        this.svPower = null;
        this.svResourceNodes = null;
        if (this.saveStatus?.loaded) await this.loadSaveActiveSubTab();
      } catch (e) {
        this.saveDataError = e.message;
      } finally {
        this.saveDataLoading = false;
      }
    },

    async downloadSave() {
      if (!this.downloadSaveName.trim()) return;
      this.downloadLoading = true;
      this.downloadError = null;
      try {
        this.saveStatus = await api.save.download(this.downloadSaveName.trim());
        this.showDownloadModal = false;
        this.downloadSaveName = '';
        this.svPlayers = null;
        this.svBuildings = null;
        this.svResources = null;
        this.svPower = null;
        this.svResourceNodes = null;
        if (this.saveStatus?.loaded) await this.loadSaveActiveSubTab();
      } catch (e) {
        this.downloadError = e.message;
      } finally {
        this.downloadLoading = false;
      }
    },

    async switchSaveTab(tab) {
      this.saveTab = tab;
      this.saveDataError = null;
      await this.loadSaveActiveSubTab();
    },

    async loadSaveActiveSubTab() {
      if (!this.saveStatus?.loaded) return;
      if (this.saveTab === 'players' && !this.svPlayers) await this.loadSvPlayers();
      if (this.saveTab === 'buildings' && !this.svBuildings) await this.loadSvBuildings();
      if (this.saveTab === 'resources' && !this.svResources) await this.loadSvResources();
      if (this.saveTab === 'power' && !this.svPower) await this.loadSvPower();
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
          if (msg.event === 'save_reloaded') {
            await this.loadSaveStatus();
            this.svPlayers = null;
            this.svBuildings = null;
            this.svResources = null;
            this.svPower = null;
            this.svResourceNodes = null;
            if (this.activeTab === 'saveviewer') await this.loadSaveActiveSubTab();
            if (this.activeTab === 'map') {
              await Promise.all([this.loadSvPlayers(), this.loadSvResourceNodes()]);
              this.updateMapMarkers();
            }
          }
        } catch { /* ignore */ }
      };
    },

    formatSaveDate(dt) {
      if (!dt) return '';
      // SF API returns saveDateTime as Windows FILETIME (100-ns intervals since 1601-01-01 UTC)
      const d = new Date(dt / 10000 - 11644473600000);
      return isNaN(d.getTime()) ? '' : d.toLocaleString();
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
        await Promise.all([this.loadSvPlayers(), this.loadSvResourceNodes()]);
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

      // Resource nodes below players in z-order
      _resourceNodeLayer = L.layerGroup().addTo(_leafletMap);
      _playerLayer       = L.layerGroup().addTo(_leafletMap);

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
      this._updatePlayerMarkers();
      this._updateResourceNodeMarkers();
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
        L.circleMarker(latlng, {
          radius: 8,
          color: '#fed7aa',
          fillColor: '#f97316',
          fillOpacity: 0.9,
          weight: 2,
        })
          .bindPopup(`<strong>${player.playerName}</strong><br><span style="font-family:monospace;font-size:11px">${xM} m, ${yM} m, ${zM} m alt</span>`)
          .addTo(_playerLayer);
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
