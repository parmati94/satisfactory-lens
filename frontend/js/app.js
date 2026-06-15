import Alpine from 'alpinejs';
import { api } from './api.js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Stored outside Alpine to avoid reactivity overhead on Leaflet objects
let _leafletMap = null;
let _mapMarkerLayer = null;

// Satisfactory world → tile mapping, mirroring AnthorNet/SC-InteractiveMap's
// GameMap.js (game units = Unreal cm). SCIM's playable bounds:
const MAP_WEST  = -324698.832031;
const MAP_EAST  =  425301.832031;
const MAP_NORTH = -375000;          // negative Y = north in UE coords
const MAP_SOUTH =  375000;
const TILE_SIZE = 256;

// SCIM pads the 32768px map with a proportional border (extraBackgroundSize),
// which is what makes the *native* tile zoom 8, not 7: the padded map is
// 40960px = 160 tiles, sitting top-left inside a 256-tile (2^8) grid — exactly
// the 62.5% coverage we measured. Replicating this padding is what makes our
// markers line up with the tiles.
const MAP_BG_BASE = 32768;
const MAP_EXTRA = 4096;
const _xLen = Math.abs(MAP_WEST) + Math.abs(MAP_EAST);
const _yLen = Math.abs(MAP_NORTH) + Math.abs(MAP_SOUTH);
const _westOffset = (_xLen / MAP_BG_BASE) * MAP_EXTRA;
const _northOffset = (_yLen / MAP_BG_BASE) * MAP_EXTRA;
const MAP_W = MAP_WEST - _westOffset;
const MAP_N = MAP_NORTH - _northOffset;
const MAP_X_MAX = (Math.abs(MAP_WEST) + Math.abs(MAP_EAST)) + 2 * _westOffset;
const MAP_Y_MAX = (Math.abs(MAP_NORTH) + Math.abs(MAP_SOUTH)) + 2 * _northOffset;
const MAP_BG_SIZE = MAP_BG_BASE + MAP_EXTRA * 2;                       // 40960
const MAP_ZOOM_RATIO = Math.ceil(Math.log2(MAP_BG_SIZE / TILE_SIZE));  // 8

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
        if (!this.svPlayers && this.saveStatus?.loaded) await this.loadSvPlayers();
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
            if (this.activeTab === 'saveviewer') await this.loadSaveActiveSubTab();
            if (this.activeTab === 'map') {
              await this.loadSvPlayers();
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

    initMap() {
      if (_leafletMap) {
        _leafletMap.invalidateSize();
        this.updateMapMarkers();
        return;
      }

      const container = document.getElementById('leaflet-map');
      _leafletMap = L.map(container, {
        crs: L.CRS.Simple,
        minZoom: 3,
        maxZoom: 12,
        zoomSnap: 0.25,
        zoomDelta: 0.25,
      });

      // Bounds of the playable world (the un-padded map), expressed via the same
      // game→latLng mapping the markers use, so tiles, panning limits and markers
      // all share one coordinate system. This excludes SCIM's gray border, so
      // those border tiles are never requested.
      const bounds = L.latLngBounds(
        gameToLatLng(MAP_WEST, MAP_NORTH),
        gameToLatLng(MAP_EAST, MAP_SOUTH),
      );

      // Keep the user inside the world — stops panning out into the empty void
      _leafletMap.setMaxBounds(bounds);
      _leafletMap.options.maxBoundsViscosity = 1.0;

      // `bounds` here stops Leaflet from requesting tiles outside the world.
      L.tileLayer('/api/map/tiles/{z}/{x}/{y}', {
        noWrap: true,
        bounds,
        minNativeZoom: 3,
        maxNativeZoom: MAP_ZOOM_RATIO,
        maxZoom: 12,
        tileSize: TILE_SIZE,
        attribution: 'Tiles &copy; <a href="https://satisfactory-calculator.com">SCIM</a>',
      }).addTo(_leafletMap);

      _mapMarkerLayer = L.layerGroup().addTo(_leafletMap);

      // Center on the map, starting ~1.75 zoom levels past the "fit whole map"
      // zoom so it opens comfortably zoomed in rather than fully pulled out.
      const center = bounds.getCenter();
      const frameView = () => {
        const fitZoom = _leafletMap.getBoundsZoom(bounds);
        _leafletMap.setView(center, fitZoom + 1.75, { animate: false });
      };

      // Set an initial view immediately so the map is never view-less
      frameView();

      // ResizeObserver handles window resizes after initial load
      new ResizeObserver(() => {
        if (_leafletMap) _leafletMap.invalidateSize({ animate: false });
      }).observe(container);

      // The container may still be settling its flex layout when the map is
      // first created. Recompute size and re-frame after the browser paints,
      // otherwise the world lands in a corner. rAF is more reliable than a
      // fixed setTimeout because it fires once layout is actually committed.
      requestAnimationFrame(() => {
        if (!_leafletMap) return;
        _leafletMap.invalidateSize({ animate: false });
        frameView();
      });

      this.mapInitialized = true;
      this.updateMapMarkers();
    },

    updateMapMarkers() {
      if (!_leafletMap || !_mapMarkerLayer) return;
      _mapMarkerLayer.clearLayers();
      if (!this.svPlayers?.length) return;

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
          .addTo(_mapMarkerLayer);
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
