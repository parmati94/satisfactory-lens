// Map controller — the Leaflet + PixiJS building-footprint renderer and all
// map-tab state/methods, split out of app.js. Composed into the Alpine 'app'
// component via spread (`...mapController()`), so every method runs with `this`
// bound to the shared component proxy — cross-domain calls (this.showTooltip,
// this.svBuildings, …) resolve exactly as before. Module-level singletons below
// stay private to this file (kept off Alpine to avoid proxying Leaflet/Pixi objects).
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from './api.js';

// Stored outside Alpine to avoid reactivity overhead on Leaflet objects
let _leafletMap = null;
let _playerLayer = null;
let _resourceNodeLayer = null;
let _mapPinLayer = null;
let _fogOverlay = null;
let _buildingOverlay = null;
let _buildingOverlayContainer = null;

// Map-filter toggles persisted across reloads (localStorage 'sl-map-filters').
// Only the genuinely independent toggles — `buildings` is derived from the
// per-save categoryFilters, and the dynamic node/category filters are rebuilt
// from each loaded save, so neither is safe to persist by key.
const PERSISTED_FILTER_KEYS = ['players', 'hub', 'stamps', 'fog', 'purityImpure', 'purityNormal', 'purityPure'];
let _buildingHitList = [];
// Uniform spatial grid over _buildingHitList for O(1) hover/click picking: a megabase
// has 100k+ buildings, and a linear scan per mousemove is what tanks interaction on big
// saves. Each building is bucketed into every cell its AABB overlaps, so a pick only
// tests the few candidates in the mouse's cell. Built once per save (see _buildHitGrid).
const HIT_GRID_CM = 2500; // cell size in game-cm (~25 m); most buildings land in one cell
let _buildingHitGrid = null; // Map<"ix,iy", hitEntry[]> | null
let _splineHitList = [];
// Viewport culling for the building sprites. Every highlight/hover redraw re-runs the
// overlay draw callback (render of the whole container), so on a megabase that's a full
// 100k-sprite render on each hover change — the main source of map stutter. We toggle
// each sprite's .visible to the current (padded) viewport so render() only draws the
// on-screen subset. _cullSprites: [{ s: Sprite, gx, gy }]; _lastCullKey skips re-culling
// when the viewport hasn't moved (e.g. a hover redraw at the same pan/zoom).
let _cullSprites = [];
let _lastCullKey = null;
let _lastHoverMs = 0;
let _clickDownX = 0; // pointer-down position, to tell a click from a map drag
let _clickDownY = 0;
let _detailPopup = null; // reusable Leaflet popup for the click detail card
let _cardEntry = null;   // hit entry currently shown in the card
let _cardOpen = false;   // suppress the hover tooltip while the card is open
// Hover outline is drawn as a PIXI.Graphics inside the building overlay (the
// overlayPane, z-index 400) rather than a separate HTML canvas, so the Leaflet
// tooltipPane (650) naturally renders above it and PIXI handles all pan/zoom
// reprojection. _pixiUtils/_unitsPerCm are captured at sprite-rebuild time so
// the outline shares the sprites' coordinate space.
let _highlightGfx = null;
let _pixiUtils = null;
let _unitsPerCm = 1;
// category → array of PIXI display objects (sprite layer + spline graphics) for
// that category, so per-category filter toggles can flip visibility cheaply.
let _categoryDisplayObjects = new Map();
// One shared rounded-rect white texture, generated once, used (tinted) for every
// non-foundation building sprite. Same draw cost/batching as PIXI.Texture.WHITE —
// the corner radius simply scales with each footprint when the texture stretches.
let _roundedTex = null;
// Per-build-class silhouette textures, baked once from each class's outline
// polygon (see getOutlineTexture). Keyed by buildClass; persists across sprite
// rebuilds like _roundedTex. Each value is { texture, w, h, cx, cy } in game-cm.
let _outlineTexCache = new Map();
// Reads the current accent's `--accent-500` (an "R G B" triplet) and packs it
// into a 0xRRGGBB int for PIXI tinting, so the building highlight follows the
// active theme. Falls back to orange-500 if the var isn't resolvable.
function accentHexInt() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent-500').trim();
  const m = raw.match(/(\d+)\s+(\d+)\s+(\d+)/);
  if (!m) return 0xf97316;
  return (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]);
}

function getRoundedTexture(PIXI, renderer) {
  if (_roundedTex) return _roundedTex;
  const S = 96;
  const R = Math.round(S * 0.2); // 20% corner radius reads as soft, not blobby
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff);
  g.drawRoundedRect(0, 0, S, S, R);
  g.endFill();
  // resolution >1 supersamples so the corners stay smooth when scaled down.
  _roundedTex = renderer.generateTexture(g, {
    resolution: 3,
    scaleMode: PIXI.SCALE_MODES.LINEAR,
  });
  g.destroy(true);
  return _roundedTex;
}

// Bake a building's top-down silhouette polygon (building-local game-cm) into a
// white texture, once per build class. Drawn white so the per-category tint
// (sprite.tint) colours it exactly like the rounded-rect sprites — so silhouette
// buildings keep batching, tinting and live recolour for free. Returns the
// texture plus the polygon's bbox size (w,h) and centre offset (cx,cy) in
// game-cm, which the caller uses to size and place the sprite.
function getOutlineTexture(PIXI, renderer, buildClass, outline) {
  const cached = _outlineTexCache.get(buildClass);
  if (cached) return cached;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outline) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);

  // Draw at a fixed pixel budget on the longer side; resolution>1 supersamples
  // so edges stay smooth when the sprite is scaled to its real footprint.
  const TARGET = 128;
  const s = TARGET / Math.max(w, h);
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff);
  g.moveTo((outline[0][0] - minX) * s, (outline[0][1] - minY) * s);
  for (let i = 1; i < outline.length; i++) {
    g.lineTo((outline[i][0] - minX) * s, (outline[i][1] - minY) * s);
  }
  g.closePath();
  g.endFill();
  const texture = renderer.generateTexture(g, {
    resolution: 3,
    scaleMode: PIXI.SCALE_MODES.LINEAR,
  });
  g.destroy(true);

  const meta = { texture, w, h, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  _outlineTexCache.set(buildClass, meta);
  return meta;
}

// Per-build-class top-down height-relief textures, loaded from the static PNGs
// baked offline (generate_building_footprints.py). Grayscale relief in RGB +
// alpha mask, so the per-category sprite tint colours it like the other sprites
// (recolour/visibility stay free). Loads async; the sprite is scaled by the
// manifest's native pixel size so it's correct the instant the image arrives.
let _reliefTexCache = new Map();
function getReliefTexture(PIXI, buildClass) {
  let t = _reliefTexCache.get(buildClass);
  if (!t) {
    t = PIXI.Texture.from(`/assets/building-relief/${buildClass}.png`);
    _reliefTexCache.set(buildClass, t);
  }
  return t;
}

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

// Squared distance from point (px,py) to segment (ax,ay)-(bx,by). Squared form
// avoids a sqrt per segment in the hover hit-test hot loop.
function distSqToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

export function mapController() {
  return {
    // ── Phase 3: Map ─────────────────────────────────────────────────────
    mapInitialized: false,
    svResourceNodes: null,
    mapRefreshing: false,
    mapFiltersOpen: false,
    mapFilters: {
      players:       true,
      hub:           true,
      stamps:        true,
      fog:           true,
      buildings:     true,
      purityImpure:  true,
      purityNormal:  true,
      purityPure:    true,
    },
    // Collapsible filter-panel sections.
    mapSections: { overlays: true, buildings: true, nodes: true },
    // Per-resource-type node toggles, keyed by resourceClass (e.g. Desc_OreIron).
    // Populated dynamically from the loaded nodes (only types present in the save).
    nodeTypeFilters: {},
    // Per-building-category toggles + the category list (label/color/count),
    // both built dynamically from the loaded footprints/splines.
    categoryFilters: {},
    buildingCategories: [],
    // Per-category color overrides (category → '#rrggbb'), persisted to
    // localStorage. Override wins over the backend default palette; applies to
    // building sprites (splines keep their default for now). See applyTheme-style
    // persistence in _loadCategoryColors/_persistCategoryColors.
    categoryColorOverrides: {},
    // Dark-themed color picker popover (replaces the native OS picker). Anchored
    // to the clicked swatch via fixed positioning so it escapes the filter
    // panel's overflow/blur clipping.
    colorPicker: { open: false, category: null, top: 0, left: 0, h: 0, s: 0, v: 0.5 },
    // Curated palette that reads well on the dark map (reds → grays).
    mapColorPresets: [
      '#e0533d', '#e07a3d', '#e0a93d', '#d9c84a', '#a8c84f', '#6fae84',
      '#4fb09a', '#4f9bb0', '#5d86b0', '#6f7fd1', '#9a83c0', '#c47fa3',
      '#d0698a', '#b0524f', '#8a98a8', '#6b7280', '#475569', '#c8cdd6',
    ],
    svMapPins: null,
    svBuildingFootprints: null,
    mouseCoord: { x: null, y: null }, // live game coords under the cursor (cm)
    // Click-to-teleport menu: a compact speech-bubble player picker whose tail
    // points at the right-clicked spot. gx/gy hold the picked world coords (cm);
    // left/top/w place the bubble; tailEdge/tailLeft place the tail (see
    // _openTeleportMenu). Pick a player to stage a SetPlayerPosition edit.
    teleportMenu: { open: false, gx: 0, gy: 0, loading: false, left: 0, top: 0, w: 232, tailEdge: 'bottom', tailLeft: 116 },
    markerMenu: { open: false, guid: '', name: '', colorHex: '#888888', left: 0, top: 0, w: 240, tailEdge: 'bottom', tailLeft: 120 },
    // ─────────────────────────────────────────────────────────────────────
    // ── Phase 3: Map methods ──────────────────────────────────────────────

    toggleMapFilters() {
      this.mapFiltersOpen = !this.mapFiltersOpen;
    },

    toggleMapFilter(key) {
      this.mapFilters[key] = !this.mapFilters[key];
      this._persistMapFilters();
      this.updateMapMarkers();
    },

    // Persist/restore the independent filter toggles so the map remembers how
    // the user left it (e.g. fog off) across reloads. See PERSISTED_FILTER_KEYS.
    _loadMapFilters() {
      try {
        const saved = JSON.parse(localStorage.getItem('sl-map-filters') || '{}');
        for (const k of PERSISTED_FILTER_KEYS) {
          if (typeof saved[k] === 'boolean') this.mapFilters[k] = saved[k];
        }
      } catch { /* ignore corrupt prefs */ }
    },

    _persistMapFilters() {
      const out = {};
      for (const k of PERSISTED_FILTER_KEYS) out[k] = this.mapFilters[k];
      localStorage.setItem('sl-map-filters', JSON.stringify(out));
    },

    // Restore persisted filters to their defaults (all on) and clear storage.
    _resetMapFilters() {
      for (const k of PERSISTED_FILTER_KEYS) this.mapFilters[k] = true;
      localStorage.removeItem('sl-map-filters');
      this.updateMapMarkers();
    },

    toggleMapSection(key) {
      this.mapSections[key] = !this.mapSections[key];
    },

    toggleAllNodes() {
      const anyOn = this.mapFilters.purityImpure || this.mapFilters.purityNormal || this.mapFilters.purityPure;
      this.mapFilters.purityImpure = !anyOn;
      this.mapFilters.purityNormal = !anyOn;
      this.mapFilters.purityPure   = !anyOn;
      this._persistMapFilters();
      this.updateMapMarkers();
    },

    nodeCountByPurity(purity) {
      return this.svResourceNodes?.filter(n => n.purity === purity && n.icon).length ?? 0;
    },

    // Distinct resource types present in the save (only those with an icon),
    // most-common first — drives the type-filter chip grid.
    nodeTypeList() {
      if (!this.svResourceNodes) return [];
      const m = new Map();
      for (const n of this.svResourceNodes) {
        if (!n.icon) continue;
        let e = m.get(n.resourceClass);
        if (!e) { e = { key: n.resourceClass, label: n.label, icon: n.icon, count: 0 }; m.set(n.resourceClass, e); }
        e.count++;
      }
      return Array.from(m.values()).sort((a, b) => b.count - a.count);
    },

    // Default any newly-seen resource type to on (reactive add via Alpine proxy).
    _ensureNodeTypeFilters() {
      for (const t of this.nodeTypeList()) {
        if (this.nodeTypeFilters[t.key] === undefined) this.nodeTypeFilters[t.key] = true;
      }
    },

    nodeTypesAllOn() {
      const list = this.nodeTypeList();
      return list.length > 0 && list.every(t => this.nodeTypeFilters[t.key]);
    },

    toggleNodeType(key) {
      this.nodeTypeFilters[key] = !this.nodeTypeFilters[key];
      this.updateMapMarkers();
    },

    toggleAllNodeTypes() {
      const list = this.nodeTypeList();
      const anyOn = list.some(t => this.nodeTypeFilters[t.key]);
      for (const t of list) this.nodeTypeFilters[t.key] = !anyOn;
      this.updateMapMarkers();
    },

    // ── Building category filters ─────────────────────────────────────────
    // Build the category list (label/color/count) from the loaded footprints +
    // splines, defaulting any newly-seen category to on. Most-common first.
    _ensureBuildingCategories() {
      const data = this.svBuildingFootprints;
      if (!data) { this.buildingCategories = []; return; }
      const m = new Map();
      // `recolorable` marks sprite-backed categories — only those can be retinted
      // live today (spline categories keep their default; see PLANNING).
      const bump = (cat, color, n, isSprite) => {
        let e = m.get(cat);
        if (!e) { e = { category: cat, color, count: 0, recolorable: false }; m.set(cat, e); }
        e.count += n;
        if (isSprite) e.recolorable = true;
      };
      for (let i = 0; i < (data.typeIndex?.length ?? 0); i++) {
        const t = data.types[data.typeIndex[i]];
        bump(t.category, t.color, 1, true);
      }
      for (const g of (data.splines ?? [])) bump(g.category, g.color, g.lines.length, false);

      this.buildingCategories = Array.from(m.values()).sort((a, b) => b.count - a.count);
      for (const c of this.buildingCategories) {
        if (this.categoryFilters[c.category] === undefined) this.categoryFilters[c.category] = true;
      }
    },

    buildingCategoriesAllOn() {
      return this.buildingCategories.length > 0 &&
        this.buildingCategories.every(c => this.categoryFilters[c.category]);
    },

    toggleBuildingCategory(cat) {
      this.categoryFilters[cat] = !this.categoryFilters[cat];
      this.mapFilters.buildings = this.buildingCategories.some(c => this.categoryFilters[c.category]);
      this._applyCategoryVisibility();
    },

    toggleAllBuildingCategories() {
      const anyOn = this.buildingCategories.some(c => this.categoryFilters[c.category]);
      for (const c of this.buildingCategories) this.categoryFilters[c.category] = !anyOn;
      this.mapFilters.buildings = !anyOn;
      this._applyCategoryVisibility();
    },

    // Flip PIXI visibility of each category's sprite layer + spline graphics to
    // match categoryFilters, then redraw. `redraw` is false when called mid-draw
    // (from the rebuild) to avoid re-entering the overlay draw callback.
    _applyCategoryVisibility(redraw = true) {
      for (const [cat, objs] of _categoryDisplayObjects) {
        const vis = this.categoryFilters[cat] !== false;
        for (const o of objs) o.visible = vis;
      }
      if (redraw) _buildingOverlay?.redraw();
    },

    // ── Per-category map colors ───────────────────────────────────────────
    // The backend bakes one default hex per category; users can override it per
    // category (persisted to localStorage). Override wins; building sprites
    // recolor live in place. Splines keep their default for now (their color is
    // baked into the Graphics geometry — see PLANNING).
    _categoryDefaultColor(cat) {
      return this.buildingCategories.find((c) => c.category === cat)?.color || '#828b99';
    },
    effectiveCategoryColor(cat) {
      return this.categoryColorOverrides[cat] || this._categoryDefaultColor(cat);
    },
    hasCategoryColorOverride(cat) {
      return !!this.categoryColorOverrides[cat];
    },
    // Open the dark color popover anchored to the clicked swatch. Prefers the
    // right of the swatch (panel sits on the map's left edge); flips/clamps to
    // stay on-screen. Seeds the HSV picker from the category's current color.
    openColorPicker(cat, evt) {
      const r = evt.currentTarget.getBoundingClientRect();
      const W = 240, H = 340, M = 8;
      let left = r.right + M;
      if (left + W > window.innerWidth - M) left = r.left - W - M;
      if (left < M) left = M;
      let top = r.top;
      if (top + H > window.innerHeight - M) top = window.innerHeight - H - M;
      if (top < M) top = M;
      const { h, s, v } = this._hexToHsv(this.effectiveCategoryColor(cat));
      this.colorPicker = { open: true, mode: 'category', category: cat, markerGuid: null, label: cat, top, left, h, s, v };
    },
    // Same dark HSV picker, retargeted to a map marker's colour (staged edit).
    openMarkerColorPicker(guid, evt) {
      const r = evt.currentTarget.getBoundingClientRect();
      const W = 240, H = 340, M = 8;
      let left = r.right + M;
      if (left + W > window.innerWidth - M) left = r.left - W - M;
      if (left < M) left = M;
      let top = r.top;
      if (top + H > window.innerHeight - M) top = window.innerHeight - H - M;
      if (top < M) top = M;
      const stamp = this.effectiveStamps().find(s => s.guid === guid) || this._baselineStamp(guid);
      const { h, s, v } = this._hexToHsv(this.rgbToHex(stamp.color));
      this.colorPicker = { open: true, mode: 'marker', category: null, markerGuid: guid, label: stamp.name || 'Marker', top, left, h, s, v };
    },
    closeColorPicker() {
      this.colorPicker.open = false;
    },

    // ── HSV color picker plumbing ─────────────────────────────────────────
    _hsvToHex(h, s, v) {
      const c = v * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = v - c;
      let r = 0, g = 0, b = 0;
      if (h < 60)       { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else              { r = c; b = x; }
      const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
      return `#${to(r)}${to(g)}${to(b)}`;
    },
    _hexToHsv(hex) {
      if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) return { h: 0, s: 0, v: 0.5 };
      const n = parseInt(hex.slice(1), 16);
      const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      let h = 0;
      if (d !== 0) {
        if (max === r)      h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else                h = (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
      }
      return { h, s: max === 0 ? 0 : d / max, v: max };
    },
    // Current picker color as hex (drives the SV-box hue, preview, thumbs).
    pickerHex() {
      const p = this.colorPicker;
      return this._hsvToHex(p.h, p.s, p.v);
    },
    pickerHueHex() {
      return this._hsvToHex(this.colorPicker.h, 1, 1);
    },
    _applyPickerColor() {
      const p = this.colorPicker;
      const hex = this._hsvToHex(p.h, p.s, p.v);
      if (p.mode === 'marker') this.setMarker(p.markerGuid, { color: this._hexToRgb(hex) });
      else this.setCategoryColor(p.category, hex);
    },
    // Pointer drag helper: applies onMove now and on every move until release.
    _startDrag(evt, onMove) {
      evt.preventDefault();
      const move = (e) => onMove(e);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      onMove(evt);
    },
    pickerSVDown(evt) {
      const rect = evt.currentTarget.getBoundingClientRect();
      this._startDrag(evt, (e) => {
        this.colorPicker.s = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        this.colorPicker.v = 1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
        this._applyPickerColor();
      });
    },
    pickerHueDown(evt) {
      const rect = evt.currentTarget.getBoundingClientRect();
      this._startDrag(evt, (e) => {
        this.colorPicker.h = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * 360;
        this._applyPickerColor();
      });
    },
    // Preset / hex entry: set the color AND re-sync the HSV thumbs.
    pickerPick(hex) {
      Object.assign(this.colorPicker, this._hexToHsv(hex));
      this._applyPickerColor();
    },
    pickerSetHex(val) {
      if (!/^#[0-9a-fA-F]{6}$/.test(val)) return; // wait for a complete hex
      this.pickerPick(val.toLowerCase());
    },
    pickerReset() {
      const p = this.colorPicker;
      if (p.mode === 'marker') {
        const base = this._baselineStamp(p.markerGuid);
        if (base) {
          this.setMarker(p.markerGuid, { color: { ...base.color } });
          Object.assign(this.colorPicker, this._hexToHsv(this.rgbToHex(base.color)));
        }
        return;
      }
      this.resetCategoryColor(p.category);
      Object.assign(this.colorPicker, this._hexToHsv(this.effectiveCategoryColor(p.category)));
    },
    setCategoryColor(cat, hex) {
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
      this.categoryColorOverrides[cat] = hex.toLowerCase();
      this._persistCategoryColors();
      this._recolorCategorySprites(cat);
    },
    resetCategoryColor(cat) {
      if (!this.categoryColorOverrides[cat]) return;
      delete this.categoryColorOverrides[cat];
      this._persistCategoryColors();
      this._recolorCategorySprites(cat);
    },
    // Clear every per-category map color override at once (App Settings / reset).
    resetAllCategoryColors() {
      const cats = Object.keys(this.categoryColorOverrides);
      if (!cats.length) return;
      this.categoryColorOverrides = {};
      this._persistCategoryColors();
      cats.forEach((cat) => this._recolorCategorySprites(cat));
    },
    // Live in-place recolor: retint a category's sprites without rebuilding the
    // overlay. Each category's display objects include the sprite layer Container
    // (its children are the sprites) and any spline Graphics (childless — skipped).
    _recolorCategorySprites(cat) {
      const objs = _categoryDisplayObjects.get(cat);
      if (!objs) return;
      const tint = parseInt(this.effectiveCategoryColor(cat).slice(1), 16);
      for (const o of objs) {
        if (o.children) for (const child of o.children) child.tint = tint;
      }
      _buildingOverlay?.redraw();
    },
    _loadCategoryColors() {
      try {
        this.categoryColorOverrides = JSON.parse(localStorage.getItem('sl-map-colors') || '{}') || {};
      } catch {
        this.categoryColorOverrides = {};
      }
    },
    _persistCategoryColors() {
      localStorage.setItem('sl-map-colors', JSON.stringify(this.categoryColorOverrides));
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
        // Cap two levels past native (tiles top out at zoom 6) — beyond ~4× overzoom
        // the stretched tiles get too blurry to be useful. Matches the tile layer's
        // maxZoom so there's no zoom range where the base layer stops rendering (blackout).
        maxZoom: 8,
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
        maxZoom: 8,
        tileSize: TILE_SIZE,
        // Keep more off-screen tiles mounted (default 2) so short pans don't drop
        // and re-request them; and don't churn tile requests mid-zoom-animation.
        keepBuffer: 4,
        updateWhenZooming: false,
      }).addTo(_leafletMap);

      // Pane stack around the fog overlay (Leaflet defaults: tilePane 200,
      // overlayPane 400 = building WebGL, markerPane 600):
      //   resourceNodes (450) → fog (500) → markerPane (600)
      // so the fog blacks out terrain, buildings AND undiscovered resource
      // nodes, while live player/HUB/stamp markers stay visible on top.
      _leafletMap.createPane('resourceNodes');
      _leafletMap.getPane('resourceNodes').style.zIndex = 450;
      _leafletMap.createPane('fog');
      _leafletMap.getPane('fog').style.zIndex = 500;
      _leafletMap.getPane('fog').style.pointerEvents = 'none';

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

      // Reusable Leaflet popup for the click detail card — popupPane, above PIXI.
      _detailPopup = L.popup({
        className: 'sf-detail-popup',
        maxWidth: 260,
        autoPanPadding: [40, 40],
        offset: [0, -4],
      });
      // Hover tooltip is noise while the card is open; suppress it for our popup.
      _leafletMap.on('popupopen', (e) => {
        if (e.popup === _detailPopup) { _cardOpen = true; this._endBuildingHover(mapEl); }
      });
      _leafletMap.on('popupclose', (e) => {
        if (e.popup === _detailPopup) { _cardOpen = false; _cardEntry = null; }
      });

      // Native mousemove fires regardless of whether PIXI canvas absorbed the event.
      mapEl.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - _lastHoverMs < 16) return;
        _lastHoverMs = now;
        const cp = _leafletMap.mouseEventToContainerPoint(e);
        const latlng = _leafletMap.containerPointToLatLng(cp);
        const g = latLngToGame(latlng);
        this.mouseCoord = { x: Math.round(g.x), y: Math.round(g.y) };
        this._handleBuildingHover(latlng);
      });
      mapEl.addEventListener('mouseleave', () => {
        this.mouseCoord = { x: null, y: null };
        this._endBuildingHover(mapEl);
      });

      // Click → detail card. Track pointer-down so a map drag isn't read as a click.
      mapEl.addEventListener('mousedown', (e) => { _clickDownX = e.clientX; _clickDownY = e.clientY; });
      mapEl.addEventListener('click', (e) => {
        // Clicks inside the open card: only the action button does anything; let
        // Leaflet handle the rest (e.g. its close button).
        if (e.target.closest?.('.leaflet-popup')) {
          if (e.target.closest('.sf-card-action') && _cardEntry) this.openInSaveViewer(_cardEntry);
          return;
        }
        if (Math.hypot(e.clientX - _clickDownX, e.clientY - _clickDownY) > 5) return; // was a drag
        if (!this.mapFilters.buildings) return;
        const cp = _leafletMap.mouseEventToContainerPoint(e);
        const latlng = _leafletMap.containerPointToLatLng(cp);
        const hit = this._pickBuildingAt(latlng);
        if (!hit) return;
        const anchor = hit.isSpline ? latlng : gameToLatLng(hit.entry.cx, hit.entry.cy);
        _detailPopup.setLatLng(anchor).setContent(this._buildingCardHtml(hit.entry, hit.isSpline));
        _leafletMap.openPopup(_detailPopup);
        // After openPopup — replacing an existing card fires popupclose, which
        // nulls _cardEntry; set it last so the action button keeps its reference.
        _cardEntry = hit.entry;
        if (!hit.isSpline) this._enrichBuildingCard(hit.entry);
      });

      // Right-click → teleport player-picker. Replace the browser's native context
      // menu (preventDefault) with our own, anchored at the cursor's world coords —
      // so it teleports "here" regardless of what's underneath, and never competes
      // with left-click (building cards) or double-click zoom.
      mapEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const cp = _leafletMap.mouseEventToContainerPoint(e);
        const latlng = _leafletMap.containerPointToLatLng(cp);
        this._openTeleportMenu(e, latlng);
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
      this.updateFogOverlay();
    },

    // Show/hide the discovered-area fog overlay. Driven by the `fog` map filter
    // (default on) and the loaded save; the overlay image is cache-busted per
    // save so a reload re-fetches it.
    updateFogOverlay() {
      if (!_leafletMap) return;
      const show = this.mapFilters.fog && this.saveStatus?.loaded;
      if (!show) {
        if (_fogOverlay) { _leafletMap.removeLayer(_fogOverlay); _fogOverlay = null; }
        return;
      }
      const bounds = L.latLngBounds(
        gameToLatLng(MAP_WEST, MAP_NORTH),
        gameToLatLng(MAP_EAST, MAP_SOUTH),
      );
      const url = api.save.fogUrl(this.saveStatus?.loadedAt ?? '');
      if (!_fogOverlay) {
        _fogOverlay = L.imageOverlay(url, bounds, {
          pane: 'fog',
          interactive: false,
          className: 'sf-fog-overlay',
        });
        // Saves without fog data 404 the image — drop the overlay quietly.
        _fogOverlay.on('error', () => {
          if (_fogOverlay) { _leafletMap.removeLayer(_fogOverlay); _fogOverlay = null; }
        });
        _fogOverlay.addTo(_leafletMap);
      } else if (_fogOverlay._url !== url) {
        _fogOverlay.setUrl(url);
      }
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
        if (container.visible) this._cullToViewport();
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

    // Toggle each building sprite's visibility to the current (padded) viewport so the
    // renderer only draws the on-screen subset. Keyed on bounds+zoom: a redraw at the
    // same viewport (hover highlight) is a no-op, so only pan/zoom actually re-culls.
    // Composes with per-category filters (those set the category container's .visible).
    _cullToViewport() {
      if (!_leafletMap || !_cullSprites.length) return;
      const b = _leafletMap.getBounds();
      const c1 = latLngToGame(b.getNorthWest());
      const c2 = latLngToGame(b.getSouthEast());
      let minX = Math.min(c1.x, c2.x), maxX = Math.max(c1.x, c2.x);
      let minY = Math.min(c1.y, c2.y), maxY = Math.max(c1.y, c2.y);
      // Pad by 25% of the span each side so a pan reveals already-visible sprites
      // before the next moveend re-culls (no blank edge), and so the generous-area
      // hover never points at a culled sprite near the edge.
      const padX = (maxX - minX) * 0.25, padY = (maxY - minY) * 0.25;
      minX -= padX; maxX += padX; minY -= padY; maxY += padY;
      const key = _leafletMap.getZoom() + '|' + (minX | 0) + '|' + (minY | 0) + '|' + (maxX | 0) + '|' + (maxY | 0);
      if (key === _lastCullKey) return; // viewport unchanged — visibility still valid
      _lastCullKey = key;
      for (const c of _cullSprites) {
        c.s.visible = c.gx >= minX && c.gx <= maxX && c.gy >= minY && c.gy <= maxY;
      }
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
      _buildingHitGrid = null;
      _splineHitList = [];
      _cullSprites = [];
      _lastCullKey = null;
      _categoryDisplayObjects = new Map();
      if (!data) return;

      // Game-cm → overlay layer-point is a fixed linear (affine) transform
      // (CRS.Simple and our gameToLatLng mapping are both pure linear) — derive
      // it once from three reference points rather than reprojecting per point.
      const p0 = utils.latLngToLayerPoint(gameToLatLng(0, 0));
      const p1 = utils.latLngToLayerPoint(gameToLatLng(1000, 0));
      const p2 = utils.latLngToLayerPoint(gameToLatLng(0, 1000));
      const unitsPerCm = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 1000;
      _unitsPerCm = unitsPerCm;
      // Basis vectors (layer-points per game-cm) for the affine game→layer map.
      const exX = (p1.x - p0.x) / 1000, exY = (p1.y - p0.y) / 1000;
      const eyX = (p2.x - p0.x) / 1000, eyY = (p2.y - p0.y) / 1000;
      const gameToLayer = (gx, gy) => ({ x: p0.x + gx * exX + gy * eyX, y: p0.y + gx * exY + gy * eyY });

      // Resolve a category's sprite tint, honoring any user color override over
      // the backend default. Memoised per rebuild so it's one parse per category.
      const _tintMemo = new Map();
      const tintForCategory = (cat, fallbackHex) => {
        let t = _tintMemo.get(cat);
        if (t === undefined) {
          const hex = this.categoryColorOverrides[cat] || fallbackHex;
          t = parseInt(hex.slice(1), 16);
          _tintMemo.set(cat, t);
        }
        return t;
      };

      // Track every display object per category so per-category filters can flip
      // their visibility without a full rebuild.
      const registerCategoryObj = (category, obj) => {
        let arr = _categoryDisplayObjects.get(category);
        if (!arr) { arr = []; _categoryDisplayObjects.set(category, arr); }
        arr.push(obj);
      };

      const categoryLayers = new Map();
      const categoryContainer = (category) => {
        let layer = categoryLayers.get(category);
        if (!layer) {
          layer = new PIXI.Container();
          categoryLayers.set(category, layer);
          container.addChild(layer);
          registerCategoryObj(category, layer);
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

      // Foundations stay sharp-cornered so floor tiles abut cleanly; everything
      // else gets the softened rounded texture.
      const SHARP_CATEGORIES = new Set(['Foundations']);
      const roundedTex = getRoundedTexture(PIXI, utils.getRenderer());

      for (let i = 0; i < data.x.length; i++) {
        const type = data.types[data.typeIndex[i]];
        const yaw = data.yaw[i];
        const fp = type.footprint;
        const cos = Math.cos(yaw), sin = Math.sin(yaw);

        // Resolve the drawn shape, best first: a top-down height-relief image
        // (true 3-D detail) → a baked silhouette polygon → the box. All end up as
        // tinted sprites so batching, the category tint and live recolour are
        // identical; the relief is just a richer texture. drawnW/H + drawnCx/Cy
        // describe the drawn footprint (cm); relief carries native pixel dims too.
        let tex, drawnW, drawnH, drawnCx, drawnCy, reliefPx = null;
        if (fp.relief) {
          tex = getReliefTexture(PIXI, type.buildClass);
          reliefPx = fp.relief;
          drawnW = fp.relief.w; drawnH = fp.relief.d;
          drawnCx = fp.relief.cx; drawnCy = fp.relief.cy;
        } else if (fp.outline) {
          const m = getOutlineTexture(PIXI, utils.getRenderer(), type.buildClass, fp.outline);
          tex = m.texture;
          drawnW = m.w; drawnH = m.h;
          drawnCx = m.cx; drawnCy = m.cy;
        } else {
          tex = SHARP_CATEGORIES.has(type.category) ? PIXI.Texture.WHITE : roundedTex;
          drawnW = fp.width; drawnH = fp.depth;
          drawnCx = fp.offsetX; drawnCy = fp.offsetY;
        }

        // Shrink slightly so the dark map bleeds through between adjacent buildings.
        const shrink = Math.max(1 - (GAP_CM * 2) / Math.min(drawnW, drawnH), MIN_RATIO);
        const fillW = drawnW * shrink, fillH = drawnH * shrink;

        // Rotate the shape's local-space centre offset by yaw before adding to world pos.
        const worldX = data.x[i] + drawnCx * cos - drawnCy * sin;
        const worldY = data.y[i] + drawnCx * sin + drawnCy * cos;
        const point = utils.latLngToLayerPoint(gameToLatLng(worldX, worldY));

        const sprite = new PIXI.Sprite(tex);
        sprite.anchor.set(0.5);
        sprite.tint = tintForCategory(type.category, type.color);
        sprite.alpha = 0.88;
        sprite.x = point.x;
        sprite.y = point.y;
        if (reliefPx) {
          // Relief PNGs load async — scale by the manifest's native pixel size so
          // the sprite is correct the moment the image arrives (sprite.width would
          // bake in the 1×1 placeholder size and render wrong on load).
          sprite.scale.set(
            Math.max(fillW * unitsPerCm, 1) / reliefPx.pw,
            Math.max(fillH * unitsPerCm, 1) / reliefPx.ph,
          );
        } else {
          sprite.width = Math.max(fillW * unitsPerCm, 1);
          sprite.height = Math.max(fillH * unitsPerCm, 1);
        }
        sprite.rotation = yaw;

        categoryContainer(type.category).addChild(sprite);
        // Register for viewport culling (drawn centre in game-cm).
        _cullSprites.push({ s: sprite, gx: worldX, gy: worldY });

        // Full footprint for hit testing — generous hover area even for thin belts/pipes.
        // Skip structural categories: they're numerous, uninteresting, and their
        // large 2-D footprints would block hover access to machines sitting on top.
        if (!SKIP_HIT_CATEGORIES.has(type.category)) {
          // Hit-test against the drawn footprint bbox (its centre is worldX/worldY).
          const hw = drawnW / 2, hh = drawnH / 2;
          _buildingHitList.push({
            cx: worldX, cy: worldY, hw, hh, cos, sin,
            // Raw (un-offset) instance position — the key for matching this map
            // instance to its row in the Explorer's building list (and back).
            gx: data.x[i], gy: data.y[i],
            // Layer-point centre + yaw for drawing the outline in the overlay's
            // (rebuild-zoom) coordinate space, matching how the sprite is placed.
            lpx: point.x, lpy: point.y, yaw,
            aabbHW: hw * Math.abs(cos) + hh * Math.abs(sin),
            aabbHH: hw * Math.abs(sin) + hh * Math.abs(cos),
            label: type.label,
            buildClass: type.buildClass,
            category: type.category,
            // Real silhouette polygon + its bbox centre, so the hover highlight
            // traces the true shape. relief and outline buildings both carry it.
            outline: fp.outline || null,
            ocx: drawnCx, ocy: drawnCy,
          });
        }
      }

      // ── Spline buildables (belts/pipes/hypertubes/rails) drawn as lines ────
      // One PIXI.Graphics per category so each gets its own colour; line width is
      // in game-cm (× unitsPerCm) so it scales with zoom like the footprints.
      const SPLINE_WIDTH_CM = {
        'Conveyors & Belts': 110,
        'Pipes & Fluids':     75,
        'Hypertubes':        150,
        'Trains & Rails':    180,
      };
      for (const group of (data.splines ?? [])) {
        if (!group.lines?.length) continue;
        const widthCm = SPLINE_WIDTH_CM[group.category] ?? 90;
        const widthLayer = Math.max(widthCm * unitsPerCm, 1);
        const tint = parseInt(group.color.slice(1), 16);
        // Game-cm hover tolerance: half the visual width plus a little padding so
        // thin belts/pipes are still easy to land on.
        const halfW = widthCm / 2 + 70;
        const g = new PIXI.Graphics();
        g.lineStyle({
          width: widthLayer,
          color: tint,
          alpha: 0.9,
          cap: PIXI.LINE_CAP.ROUND,
          join: PIXI.LINE_JOIN.ROUND,
        });
        for (const line of group.lines) {
          if (line.length < 4) continue;
          const layerPts = new Array(line.length);
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          const start = gameToLayer(line[0], line[1]);
          layerPts[0] = start.x; layerPts[1] = start.y;
          g.moveTo(start.x, start.y);
          for (let k = 2; k < line.length; k += 2) {
            const pt = gameToLayer(line[k], line[k + 1]);
            layerPts[k] = pt.x; layerPts[k + 1] = pt.y;
            g.lineTo(pt.x, pt.y);
          }
          for (let k = 0; k < line.length; k += 2) {
            if (line[k]     < minX) minX = line[k];
            if (line[k]     > maxX) maxX = line[k];
            if (line[k + 1] < minY) minY = line[k + 1];
            if (line[k + 1] > maxY) maxY = line[k + 1];
          }
          _splineHitList.push({
            gamePts: line, layerPts, halfW, halfW2: halfW * halfW, widthLayer, tint,
            minX, minY, maxX, maxY,
            label: group.label, buildClass: group.buildClass, category: group.category,
          });
        }
        container.addChild(g);
        registerCategoryObj(group.category, g);
      }

      // Index the finished hit list into the spatial grid for fast picking.
      this._buildHitGrid();

      // Apply current per-category visibility to the freshly-built objects
      // (no redraw — we're already inside the overlay draw callback).
      this._applyCategoryVisibility(false);
    },

    // Bucket every building hit entry into each grid cell its axis-aligned bounds
    // overlap. Iterating _buildingHitList in order means each bucket preserves the
    // list's global ordering, so the first-match tie-break in _pickBuildingAt is
    // unchanged from the old linear scan — just over far fewer candidates.
    _buildHitGrid() {
      const grid = new Map();
      for (const b of _buildingHitList) {
        const ix0 = Math.floor((b.cx - b.aabbHW) / HIT_GRID_CM);
        const ix1 = Math.floor((b.cx + b.aabbHW) / HIT_GRID_CM);
        const iy0 = Math.floor((b.cy - b.aabbHH) / HIT_GRID_CM);
        const iy1 = Math.floor((b.cy + b.aabbHH) / HIT_GRID_CM);
        for (let ix = ix0; ix <= ix1; ix++) {
          for (let iy = iy0; iy <= iy1; iy++) {
            const key = ix + ',' + iy;
            let bucket = grid.get(key);
            if (!bucket) { bucket = []; grid.set(key, bucket); }
            bucket.push(b);
          }
        }
      }
      _buildingHitGrid = grid;
    },

    // Shared hit-test for hover and click: returns { entry, isSpline } or null.
    // Machine rectangles take priority (belts/pipes usually run between them).
    _pickBuildingAt(latlng) {
      const { x: mx, y: my } = latLngToGame(latlng);

      // Only the buildings bucketed into the mouse's cell can contain the point.
      const bucket = _buildingHitGrid?.get(
        Math.floor(mx / HIT_GRID_CM) + ',' + Math.floor(my / HIT_GRID_CM),
      );
      if (bucket) {
        for (const b of bucket) {
          if (this.categoryFilters[b.category] === false) continue; // hidden category
          const dx = mx - b.cx, dy = my - b.cy;
          if (Math.abs(dx) > b.aabbHW || Math.abs(dy) > b.aabbHH) continue;
          const lx = dx * b.cos + dy * b.sin;
          const ly = -dx * b.sin + dy * b.cos;
          if (Math.abs(lx) <= b.hw && Math.abs(ly) <= b.hh) return { entry: b, isSpline: false };
        }
      }

      for (const s of _splineHitList) {
        if (this.categoryFilters[s.category] === false) continue; // hidden category
        if (mx < s.minX - s.halfW || mx > s.maxX + s.halfW ||
            my < s.minY - s.halfW || my > s.maxY + s.halfW) continue;
        const pts = s.gamePts;
        for (let k = 0; k < pts.length - 2; k += 2) {
          if (distSqToSegment(mx, my, pts[k], pts[k + 1], pts[k + 2], pts[k + 3]) <= s.halfW2) {
            return { entry: s, isSpline: true };
          }
        }
      }
      return null;
    },

    _handleBuildingHover(latlng) {
      const mapEl = document.getElementById('leaflet-map');
      if (_cardOpen || !this.mapFilters.buildings ||
          (!_buildingHitList.length && !_splineHitList.length)) {
        this._endBuildingHover(mapEl);
        return;
      }
      const hit = this._pickBuildingAt(latlng);
      if (hit) this._showHover(latlng, hit.entry, mapEl, hit.isSpline);
      else this._endBuildingHover(mapEl);
    },

    // Show the tooltip + outline for a hovered entry (rectangle building or
    // spline). Tooltip follows the cursor every frame; content + outline only
    // refresh when the hovered entry actually changes.
    _showHover(latlng, entry, mapEl, isSpline) {
      _buildingTooltip.setLatLng(latlng);
      if (entry !== _hoveredBuilding) {
        _hoveredBuilding = entry;
        _buildingTooltip.setContent(this._buildingTooltipHtml(entry));
        if (!_leafletMap.hasLayer(_buildingTooltip)) _leafletMap.openTooltip(_buildingTooltip);
        if (isSpline) this._drawSplineHighlight(entry);
        else this._drawBuildingHighlight(entry);
      }
      mapEl.style.cursor = 'pointer';
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
          <p class="sf-btt-hint">Click for details</p>
        </div>
      </div>`;
    },

    // A small item-icon row (input → output etc.) for the map card. `detail` is a
    // fetched MachineInstance; returns extra .sf-card-row fragments by kind.
    _cardMachineHtml(detail) {
      const icon = (cls, name) => `<img src="/assets/items/${cls}.png" title="${name || ''}" style="width:18px;height:18px;object-fit:contain;vertical-align:middle" onerror="this.style.display='none'">`;
      if (detail.kind === 'production') {
        const ins = (detail.inputs || []).map(i => icon(i.item, i.name)).join('');
        const outs = (detail.outputs || []).map(o => icon(o.item, o.name)).join('');
        const arrow = ins && outs ? `<span style="color:#9ca3af;margin:0 2px">→</span>` : '';
        const rate = detail.outputs?.[0] ? this.fmtRate(detail.outputs[0]) : '';
        const boost = detail.boostPct > 100 ? ` · ×${detail.boostPct / 100}` : '';
        // "What's it doing": producing/idle state, with the current craft-cycle
        // progress when it's actively producing — both already in the detail.
        const prog = detail.isProducing && detail.progressPct !== undefined ? ` · ${detail.progressPct}%` : '';
        const status = detail.isProducing
          ? `<span style="color:#4ade80">● Producing${prog}</span>`
          : `<span style="color:#9ca3af">○ Idle</span>`;
        return `<div class="sf-card-row"><span class="sf-card-k">Recipe</span><span class="sf-card-v">${detail.recipeName || 'None'}</span></div>
          <div style="display:flex;align-items:center;gap:3px;margin:2px 0 4px">${ins}${arrow}${outs}</div>
          <div class="sf-card-row"><span class="sf-card-k">Output</span><span class="sf-card-v">${rate ? rate + ' · ' : ''}${detail.clockPct}%${boost}</span></div>
          <div class="sf-card-row"><span class="sf-card-k">Status</span><span class="sf-card-v">${status}</span></div>`;
      }
      if (detail.kind === 'generator') {
        return `<div class="sf-card-row"><span class="sf-card-k">Fuel</span><span class="sf-card-v">${detail.fuelClass ? icon(detail.fuelClass, detail.fuelName) + ' ' : ''}${detail.fuelName || 'None'}</span></div>`
          + (detail.powerMW ? `<div class="sf-card-row"><span class="sf-card-k">Power</span><span class="sf-card-v">${detail.powerMW} MW</span></div>` : '');
      }
      // extractor
      return `<div class="sf-card-row"><span class="sf-card-k">Resource</span><span class="sf-card-v">${detail.resourceClass ? icon(detail.resourceClass, detail.resourceName) + ' ' : ''}${detail.resourceName || '—'}</span></div>
        <div class="sf-card-row"><span class="sf-card-k">Clock</span><span class="sf-card-v">${detail.clockPct}%</span></div>`;
    },

    // A compact inventory peek for the map card. `c` is a fetched StorageContainer;
    // shows the top item stacks (icon + count) plus a slot-fill bar — a read-only
    // sneak peek; the full editable grid lives in the Explorer's Storage tab.
    _cardStorageHtml(c) {
      if (!c.totalSlots || !c.contents?.length) {
        return `<div class="sf-card-row"><span class="sf-card-k">Contents</span><span class="sf-card-v">Empty</span></div>`;
      }
      const { items, overflow } = this.storagePreview(c.contents, 4);
      const stk = (i) => `<div class="sf-card-stk">
        <img src="/assets/items/${i.itemClass}.png" title="${i.displayName || ''}" onerror="this.style.display='none'">
        <span>${this.fmtCount(i.count)}</span>
      </div>`;
      const more = overflow > 0 ? `<span class="sf-card-more">+${overflow}</span>` : '';
      const pct = Math.round((c.usedSlots / c.totalSlots) * 100);
      return `<div class="sf-card-stacks">${items.map(stk).join('')}${more}</div>
        <div class="sf-card-row"><span class="sf-card-k">Slots</span><span class="sf-card-v">${c.usedSlots}/${c.totalSlots}</span></div>
        <div class="sf-card-bar"><div class="sf-card-barfill" style="width:${pct}%"></div></div>`;
    },

    // Compact integer formatter for the inventory peek (e.g. 12345 → "12.3k").
    fmtCount(n) {
      if (n >= 10000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k';
      return String(n);
    },

    // Click detail card content. Position/length fact, plus — for machines whose
    // per-instance detail has been fetched — a recipe (in→out) / fuel / resource
    // summary, for storage containers an inventory peek, and the launch button
    // into the Save Viewer. `detail` is a MachineInstance or a StorageContainer
    // (discriminated by its `contents` field).
    _buildingCardHtml(entry, isSpline, detail) {
      let factLabel, factValue;
      if (isSpline) {
        let len = 0;
        const p = entry.gamePts;
        for (let k = 0; k < p.length - 2; k += 2) {
          len += Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]);
        }
        factLabel = 'Length';
        factValue = `${(len / 100).toFixed(0)} m`;
      } else {
        factLabel = 'Position';
        factValue = `${(entry.cx / 100).toFixed(0)} m, ${(entry.cy / 100).toFixed(0)} m`;
      }
      const detailHtml = !detail ? ''
        : detail.contents !== undefined ? this._cardStorageHtml(detail)
        : this._cardMachineHtml(detail);
      return `<div class="sf-card">
        <div class="sf-card-head">
          <img class="sf-card-icon" src="/assets/buildings/${entry.buildClass}.png" onerror="this.style.display='none'">
          <div class="sf-card-headtext">
            <p class="sf-card-title">${entry.label}</p>
            <p class="sf-card-sub">${entry.category}</p>
          </div>
        </div>
        <div class="sf-card-body">
          ${detailHtml}
          <div class="sf-card-row"><span class="sf-card-k">${factLabel}</span><span class="sf-card-v">${factValue}</span></div>
        </div>
        <button class="sf-card-action" type="button">Open in Explorer
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>
      </div>`;
    },

    // After a building is clicked on the map, fetch its detail and, if the card is
    // still showing that instance, re-render with the peek: recipe/fuel/resource for
    // machines, an inventory preview for storage containers.
    async _enrichBuildingCard(entry) {
      if (!entry) return;
      if (entry.category === 'Storage') { await this._enrichStorageCard(entry); return; }
      if (!this.isInstanceableCategory(entry.category)) return;
      await this.loadMachineDetail(entry.buildClass);
      if (_cardEntry !== entry) return; // popup changed/closed while loading
      const list = this.svMachineDetail[entry.buildClass];
      if (!list?.length) return;
      let best = null, bestD = Infinity;
      for (const m of list) {
        const d = Math.hypot(Math.round(m.pos.x) - entry.gx, Math.round(m.pos.y) - entry.gy);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best) _detailPopup.setContent(this._buildingCardHtml(entry, false, best));
    },

    // Storage peek: lazily load the storage census, match the clicked container by
    // buildClass + nearest position (positions are metres in the census, game-cm on
    // the map), and re-render the card with its inventory preview. Containers the
    // census doesn't track (e.g. Dimensional Depot) simply find no match → bare card.
    async _enrichStorageCard(entry) {
      if (!this.svStorage) await this.loadSvStorage();
      if (_cardEntry !== entry) return; // popup changed/closed while loading
      const mx = Math.round(entry.gx / 100), my = Math.round(entry.gy / 100);
      let best = null, bestD = Infinity;
      for (const c of this.svStorage ?? []) {
        if (c.buildClass !== entry.buildClass || !c.position) continue;
        const d = Math.hypot(c.position.x - mx, c.position.y - my);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) _detailPopup.setContent(this._buildingCardHtml(entry, false, best));
    },

    // Jump to the Explorer sub-tab that owns this building's category and locate the
    // *exact* clicked instance: filter to its type, expand the per-instance list, then
    // scroll to + highlight the instance whose position matches the map click.
    // Matching is by position (buildClass + nearest x/y) so the lean map footprints
    // payload stays free of instanceNames.
    async openInSaveViewer(entry) {
      _leafletMap?.closePopup(_detailPopup);

      // Storage containers → the dedicated Storage tab (inventory + edit), which is
      // strictly more useful than a bare per-instance row. Falls through to the
      // category's normal tab only if the container isn't one the Storage tab tracks
      // (e.g. Dimensional Depot / lockers).
      if (entry.category === 'Storage') {
        this.saveTab = 'storage';
        this.savesDrawerOpen = false;
        await this.switchTab('saves');
        if (!this.svStorage) await this.loadSvStorage();
        if (this._focusStorageInstance(entry.buildClass, entry.gx, entry.gy)) return;
      }

      // Route to the intent tab that renders this category.
      this.saveTab = this._powerCats.has(entry.category) ? 'power'
        : this._productionCats.has(entry.category) ? 'production'
        : 'structures';
      // The search box only lives on Production/Structures; the Power tab's
      // generator group isn't filtered by it, so don't leak the label there.
      this.buildingsSearch = this.saveTab === 'power' ? '' : entry.label;
      this.savesDrawerOpen = false;
      await this.switchTab('saves');
      if (!this.svBuildings) await this.loadSvBuildings();
      this._focusBuildingInstance(entry.buildClass, entry.gx, entry.gy);
    },

    // Locate a storage container in the Storage tab by buildClass + nearest position
    // (the tab stores positions in metres; map x/y are game-cm). Expands + scrolls to
    // + highlights it. Returns true if matched, false to let the caller fall back.
    _focusStorageInstance(buildClass, x, y) {
      const mx = Math.round(x / 100), my = Math.round(y / 100);
      let best = null, bestD = Infinity;
      for (const c of this.svStorage ?? []) {
        if (c.buildClass !== buildClass || !c.position) continue;
        const d = Math.hypot(c.position.x - mx, c.position.y - my);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (!best) return false;

      this.expandedStorage = best.instanceName;
      this.highlightedInstanceName = best.instanceName;
      this.$nextTick(() => {
        document.getElementById(`storagerow-${best.instanceName}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      clearTimeout(this._instHighlightTimer);
      this._instHighlightTimer = setTimeout(() => { this.highlightedInstanceName = null; }, 4000);
      return true;
    },

    // Find the type (by buildClass) + the instance nearest (x, y), expand it (loading
    // its rich detail), then scroll to + highlight that instance's row. Shared by the
    // map → instance jump. Matches against whichever list will render (rich detail if
    // available, else lean positions) so the index/cap line up.
    async _focusBuildingInstance(buildClass, x, y) {
      let target = null;
      for (const cat of this.svBuildings?.categories ?? []) {
        const type = cat.types.find(t => t.buildClass === buildClass);
        if (type) { target = type; break; }
      }
      if (!target) return;

      this.expandedBuildingType = target.typePath;
      await this.loadMachineDetail(buildClass);

      const list = this.instanceList(target);
      if (!list.length) return;
      let bestIdx = 0, bestD = Infinity;
      for (let i = 0; i < list.length; i++) {
        const p = list[i].pos;
        const d = Math.hypot(Math.round(p.x) - x, Math.round(p.y) - y);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }

      // Ensure the matched row is within the rendered (capped) window.
      if (bestIdx >= (this.buildingInstanceCap[target.typePath] ?? this.INSTANCE_PAGE)) {
        this.buildingInstanceCap[target.typePath] = bestIdx + 1;
      }
      const inst = list[bestIdx];
      const name = this.instKey(inst);
      this.highlightedInstanceName = name;
      // Auto-expand the matched instance's inspector card (only machines with
      // rich detail are expandable — lean structural rows have no `kind`).
      if (inst.kind) this.expandedMachine = name;

      this.$nextTick(() => {
        document.getElementById(`binst-${name}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      // Clear the highlight after it has had a moment to register.
      clearTimeout(this._instHighlightTimer);
      this._instHighlightTimer = setTimeout(() => { this.highlightedInstanceName = null; }, 4000);
    },

    // Reciprocal of openInSaveViewer: from a Buildings-tab instance row, switch to
    // the Map and pan to + highlight that machine, reusing the map's own hit-test
    // entry (matched by nearest position) so the highlight + detail card match a
    // real click. Best-effort: if the Pixi overlay/hit list isn't built yet, retry
    // once it is.
    async showBuildingOnMap(buildClass, x, y) {
      await this.switchTab('map');
      const tryFocus = (attempt = 0) => {
        let best = null, bestD = Infinity;
        for (const b of _buildingHitList) {
          if (b.buildClass !== buildClass) continue;
          const d = Math.hypot(b.gx - x, b.gy - y);
          if (d < bestD) { bestD = d; best = b; }
        }
        if (!best) {
          if (attempt < 10) setTimeout(() => tryFocus(attempt + 1), 200);
          return;
        }
        const latlng = gameToLatLng(best.cx, best.cy);
        _leafletMap.setView(latlng, Math.max(_leafletMap.getZoom(), _leafletMap.getMaxZoom() - 1), { animate: true });
        this._drawBuildingHighlight(best);
        _detailPopup.setLatLng(latlng).setContent(this._buildingCardHtml(best, false));
        _leafletMap.openPopup(_detailPopup);
        _cardEntry = best;
        this._enrichBuildingCard(best);
      };
      tryFocus();
    },

    // Draws the orange outline as a rotated rect in the overlay's coordinate
    // space (same placement maths as the sprite: layer-point centre + yaw), so
    // it pans and zooms with the buildings without per-frame redraws. The line
    // width is divided by the container scale to stay ~constant on screen.
    _drawBuildingHighlight(b) {
      const g = _highlightGfx;
      if (!g || !_buildingOverlayContainer) return;
      const scale = _buildingOverlayContainer.scale.x || 1;
      g.clear();
      g.position.set(b.lpx, b.lpy);
      g.rotation = b.yaw;
      const accent = accentHexInt();

      // Silhouette buildings: trace the actual polygon (local cm relative to its
      // bbox centre, scaled to layer space) so the highlight hugs the real shape.
      if (b.outline) {
        const upc = _unitsPerCm;
        const drawPoly = () => {
          g.moveTo((b.outline[0][0] - b.ocx) * upc, (b.outline[0][1] - b.ocy) * upc);
          for (let i = 1; i < b.outline.length; i++) {
            g.lineTo((b.outline[i][0] - b.ocx) * upc, (b.outline[i][1] - b.ocy) * upc);
          }
          g.closePath();
        };
        g.lineStyle((6 / scale), accent, 0.25);
        drawPoly();
        g.lineStyle((2 / scale), accent, 1);
        drawPoly();
        _buildingOverlay?.redraw();
        return;
      }

      const w = b.hw * 2 * _unitsPerCm;
      const h = b.hh * 2 * _unitsPerCm;
      // Match the sprite's rounded corners (~20% of the shorter side) so the
      // outline doesn't look squared-off against the rounded fill.
      const r = 0.2 * Math.min(w, h);
      // Soft outer glow, then the crisp 2px line. Colour follows the theme.
      g.lineStyle((6 / scale), accent, 0.25);
      g.drawRoundedRect(-w / 2, -h / 2, w, h, r);
      g.lineStyle((2 / scale), accent, 1);
      g.drawRoundedRect(-w / 2, -h / 2, w, h, r);
      _buildingOverlay?.redraw();
    },

    // Highlights a whole spline path with a thin dark casing and the belt's own
    // colour restored on top — so it reads as an outlined line rather than a
    // solid orange fill that hides the belt.
    _drawSplineHighlight(s) {
      const g = _highlightGfx;
      if (!g || !_buildingOverlayContainer) return;
      const scale = _buildingOverlayContainer.scale.x || 1;
      const pts = s.layerPts;
      const border = 3 / scale; // ~3px casing regardless of zoom
      g.clear();
      g.position.set(0, 0);
      g.rotation = 0;
      const stroke = (width, color, alpha) => {
        g.lineStyle({ width, color, alpha, cap: 'round', join: 'round' });
        g.moveTo(pts[0], pts[1]);
        for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]);
      };
      stroke(s.widthLayer + border * 2, 0x000000, 0.9); // dark outline
      stroke(s.widthLayer, s.tint, 1);                  // belt colour on top
      _buildingOverlay?.redraw();
    },

    _clearBuildingHighlight() {
      if (_highlightGfx) {
        _highlightGfx.clear();
        _buildingOverlay?.redraw();
      }
    },

    // Open the click-to-teleport player picker as a speech bubble whose tail points
    // at the right-clicked spot. No-op when there's no loaded save with players.
    // The bubble sits centred above the click (tail pointing down); it flips below
    // when there's no room above, and clamps to the viewport while the tail still
    // tracks the click's x. The chosen world coords are carried as gx/gy (cm).
    _openTeleportMenu(e, latlng) {
      if (!this.isAdmin) return; // teleport is an edit — read-only viewers can't stage it
      if (!this.svPlayers?.length) return;
      const g = latLngToGame(latlng);
      const M = 8, W = 232, GAP = 11;
      const n = Math.min(this.svPlayers.length, 6);
      const H = 96 + n * 40; // header + rows + hint + padding (estimate; clamped below)
      const vw = window.innerWidth, vh = window.innerHeight;
      // Prefer above the click so the tail points down to the spot; flip below if tight.
      let tailEdge = 'bottom';
      let top = e.clientY - GAP - H;
      if (top < M) { tailEdge = 'top'; top = e.clientY + GAP; }
      top = Math.max(M, Math.min(top, vh - H - M));
      // Centre on the click horizontally, clamped; the tail offset still points back at it.
      const left = Math.max(M, Math.min(e.clientX - W / 2, vw - W - M));
      const tailLeft = Math.max(16, Math.min(e.clientX - left, W - 16));
      this.teleportMenu = { open: true, gx: g.x, gy: g.y, loading: false, left, top, w: W, tailEdge, tailLeft };
    },

    // Anchor the marker edit menu to the clicked stamp (mirrors _openTeleportMenu).
    _openMarkerMenu(guid, e) {
      if (!this.isAdmin) return; // marker rename/recolor/delete is admin-only (read-only viewers can't edit)
      const stamp = this.effectiveStamps().find(s => s.guid === guid) || this._baselineStamp(guid);
      if (!stamp) return;
      const M = 8, W = 240, GAP = 14, H = 188;
      const vw = window.innerWidth, vh = window.innerHeight;
      const cx = e?.clientX ?? vw / 2, cy = e?.clientY ?? vh / 2;
      let tailEdge = 'bottom';
      let top = cy - GAP - H;
      if (top < M) { tailEdge = 'top'; top = cy + GAP; }
      top = Math.max(M, Math.min(top, vh - H - M));
      const left = Math.max(M, Math.min(cx - W / 2, vw - W - M));
      const tailLeft = Math.max(16, Math.min(cx - left, W - 16));
      this.markerMenu = { open: true, guid, name: stamp.name || '', colorHex: this.rgbToHex(stamp.color), left, top, w: W, tailEdge, tailLeft };
    },

    // Stage a teleport for the chosen player to the menu's picked coords, then move
    // its marker to the staged spot. The edit lands in the shared editBuffer, so the
    // global edit bar and the Explorer's player coordinates reflect it immediately.
    async teleportPlayerTo(player) {
      const { gx, gy } = this.teleportMenu;
      this.teleportMenu.loading = true;
      try {
        await this.teleportPlayerToGround(player, gx, gy);
      } finally {
        this.teleportMenu.loading = false;
        this.teleportMenu.open = false;
      }
      this._updatePlayerMarkers();
    },

    _updatePlayerMarkers() {
      if (!_playerLayer) return;
      _playerLayer.clearLayers();
      if (!this.mapFilters.players || !this.svPlayers?.length) return;

      for (const player of this.svPlayers) {
        // Draw at the effective (staged-or-baseline) position so a click-to-teleport
        // edit moves the marker instantly, before it's persisted.
        const pos = this.effectivePosition(player);
        const edited = this.isPositionEdited(player);
        const latlng = gameToLatLng(pos.x, pos.y);
        const xM = (pos.x / 100).toFixed(0);
        const yM = (pos.y / 100).toFixed(0);
        const zM = (pos.z / 100).toFixed(0);
        const icon = L.icon({
          iconUrl: '/assets/players/player_marker.png',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          popupAnchor: [0, -14],
          className: edited ? 'sf-player-edited' : '',
        });
        const staged = edited ? ' <span style="color:rgb(var(--accent-300))">· staged</span>' : '';
        L.marker(latlng, { icon })
          .bindPopup(`<strong>${player.playerName}</strong>${staged}<br><span style="font-family:monospace;font-size:11px">${xM} m, ${yM} m, ${zM} m alt</span>`)
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

      // Player-placed map stamps — drawn from effective (staged-or-baseline) values
      // so a rename/recolor/delete previews instantly before it's persisted.
      if (this.mapFilters.stamps) {
        for (const stamp of this.effectiveStamps()) {
          const latlng = gameToLatLng(stamp.position.x, stamp.position.y);
          const { r, g, b } = stamp.color;
          const cssColor = `rgb(${r},${g},${b})`;
          const edited = this.isMarkerEdited(stamp.guid);
          const ring = edited ? 'border:2px solid rgb(var(--accent-400));box-shadow:0 0 8px rgb(var(--accent-500)/.7)' : 'border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.6)';
          const icon = L.divIcon({
            className: '',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -16],
            html: `<div style="width:28px;height:28px;border-radius:50%;background:${cssColor};${ring};display:flex;align-items:center;justify-content:center;cursor:${stamp.editable ? 'pointer' : 'default'}">
              <svg width="13" height="15" viewBox="0 0 16 18" fill="white" xmlns="http://www.w3.org/2000/svg">
                <ellipse cx="8" cy="7" rx="6" ry="6"/>
                <ellipse cx="8" cy="7" rx="2.5" ry="2.5" fill="${cssColor}"/>
                <polygon points="3,10 13,10 8,18"/>
              </svg>
            </div>`,
          });
          const label = stamp.name || 'Map Marker';
          const m = L.marker(latlng, { icon }).addTo(_mapPinLayer);
          // Editable stamps open the edit menu on click; legacy markers keep a read-only popup.
          if (stamp.editable) {
            m.on('click', (ev) => this._openMarkerMenu(stamp.guid, ev.originalEvent));
          } else {
            m.bindPopup(`<strong>${label}</strong><br><span style="font-size:11px;color:#9ca3af">legacy marker · read-only</span>`);
          }
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
        // Type axis: a node shows only if its resource type is also enabled.
        if (this.nodeTypeFilters[node.resourceClass] === false) continue;
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
        L.marker(latlng, { icon, pane: 'resourceNodes' })
          .bindPopup(`<strong>${node.label}</strong><br><span style="color:${ring};font-size:11px">${node.purity}</span><br><span style="font-family:monospace;font-size:11px">${xM} m, ${yM} m</span>`)
          .addTo(_resourceNodeLayer);
      }
    },

    // ─────────────────────────────────────────────────────────────────────

  };
}
