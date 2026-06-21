#!/usr/bin/env python3
"""
Generate a Build_ClassName -> footprint JSON mapping from pak data, for rendering
accurate building shapes on the map.

Two things per building:

  1. Box footprint (width/depth/height/offset) from mClearanceData[0].ClearanceBox
     in Build_*.json. The first clearance entry is consistently the building's
     primary ground-level footprint (EClearanceType::CT_Default). Kept as the
     fallback shape and the hover/hit area.

  2. A top-down "outline" polygon (the building's real silhouette), tried in two
     ways, best first:

     a. RENDER MESH (preferred) — from the building's StaticMesh exported as glTF
        (.glb, via FModel "Save Model"). We project every triangle to the XY plane
        (UE_X = gltfX*100, UE_Y = gltfZ*100 — CUE4Parse bakes the Z-up→Y-up swap
        and the cm→m scale into the vertices; validated against the clearance box),
        rasterise the filled triangles, morphologically close the open-frame gaps,
        and trace the outer contour. This is the true top-down shape (legs, ports,
        the lot) — SCIM-level fidelity.

     b. COLLISION (fallback, no .glb) — from BodySetup.AggGeom (already in the mesh
        .json): each collision piece snapped to a grid-aligned rectangle, unioned,
        opened/closed with square joins. Rectilinear and decent, but coarse.

     Buildings whose silhouette is essentially rectangular (foundations, walls, ...)
     emit no outline and fall back to the box renderer, keeping them crisp and the
     payload small. Either way the output is the same compact polygon
     (outline: [[x,y],...], building-local cm) — meshes are used offline only.

Output: backend/data/buildable-footprints.json
"""

import json
import math
import os
import re
import struct
from pathlib import Path

import numpy as np
import cv2
from pygltflib import GLTF2
from shapely.geometry import Polygon, MultiPolygon, box as shbox
from shapely.ops import unary_union
from shapely.affinity import rotate as shrotate, translate as shtranslate

# Outline geometry is essentially rectilinear (machines are boxes with box-shaped
# legs/notches), and so is the collision data. So we snap each collision piece to
# an axis-aligned rectangle on a grid and keep right angles, rather than convex-
# hulling + Douglas-Peucker simplifying, which chamfered straight edges into
# jagged diagonals. GRID also collapses the micro-steps that bloat the vertex
# count. OPEN_CM removes thin appendages (railings/catwalks) and refills thin
# notches with square (mitre) corners.
GRID = 25.0
OPEN_CM = 30.0
MAX_PTS = 80

# Render-mesh silhouette tuning (game-cm). PX_CM is the rasterisation resolution;
# GLB_CLOSE_CM welds the gaps in open-frame ("bones") meshes so the silhouette
# reads solid; GLB_EPS_CM is the contour simplification tolerance.
PX_CM = 4.0
GLB_CLOSE_CM = 24.0
GLB_EPS_CM = 7.0

# Height-relief image tuning. Each shaped building is rendered top-down to a
# grayscale relief (height + hillshade) with an alpha mask; the map tints it by
# category colour. RELIEF_PX_CM is the target resolution; RELIEF_MAX_PX caps the
# long side; RELIEF_MIN_H_CM gates out flat things (foundations) which gain
# nothing from relief and fall back to the box/outline renderer.
RELIEF_PX_CM = 3.0
RELIEF_MAX_PX = 384
RELIEF_MIN_H_CM = 90.0

from _paths import CONTENT as CONTENT_ROOT, BACKEND_DATA, FRONTEND_ASSETS  # noqa: E402

OUT_FILE = BACKEND_DATA / 'buildable-footprints.json'
RELIEF_DIR = FRONTEND_ASSETS / 'building-relief'
BUILDABLE_ROOT = CONTENT_ROOT / 'FactoryGame' / 'Buildable'

# Fallback for buildings with no mClearanceData (rare — decorative/non-collidable
# props). A small square so they still show up on the map rather than vanishing.
DEFAULT_FOOTPRINT = {'width': 100.0, 'depth': 100.0, 'height': 100.0, 'offsetX': 0.0, 'offsetY': 0.0}

# A building whose outline fills >RECT_FILL of its own bounding box is treated as
# a plain rectangle and emits no outline (the box renderer draws it crisply).
RECT_FILL = 0.93

_MESH_REF_RE = re.compile(r'"ObjectName":\s*"(?:StaticMesh)\'([^\']+)\'"')

# VAT (Vertex Animation Texture) meshes are named like SM_X_VAT / VAT_X / X_VAT_01
# — match "VAT" as a token bounded by non-letters, NOT as a substring, or names
# like "Ele[VAT]or" (Space Elevator) get wrongly excluded as animation meshes.
_VAT_RE = re.compile(r'(?:^|[^A-Z])VAT(?:[^A-Z]|$)')


def _is_vat_mesh(name: str) -> bool:
    return bool(_VAT_RE.search(name.upper()))


def _snap(v: float) -> float:
    return round(v / GRID) * GRID


def footprint_from_clearance(entry: dict) -> dict | None:
    box = entry.get('ClearanceBox')
    if not box or not box.get('IsValid'):
        return None
    mn, mx = box.get('Min'), box.get('Max')
    if not mn or not mx:
        return None

    width = mx['X'] - mn['X']
    depth = mx['Y'] - mn['Y']
    height = mx['Z'] - mn['Z']
    if width <= 0 or depth <= 0:
        return None

    translation = (entry.get('RelativeTransform') or {}).get('Translation') or {}
    offset_x = (mn['X'] + mx['X']) / 2 + translation.get('X', 0.0)
    offset_y = (mn['Y'] + mx['Y']) / 2 + translation.get('Y', 0.0)

    return {
        'width': round(width, 2),
        'depth': round(depth, 2),
        'height': round(height, 2),
        'offsetX': round(offset_x, 2),
        'offsetY': round(offset_y, 2),
    }


def index_meshes() -> dict[str, Path]:
    """Map every StaticMesh object name (file stem) -> its .json path."""
    idx: dict[str, Path] = {}
    for p in CONTENT_ROOT.rglob('*.json'):
        idx.setdefault(p.stem, p)
    return idx


def index_glb() -> dict[str, Path]:
    """Map every exported render mesh (file stem) -> its .glb path."""
    idx: dict[str, Path] = {}
    for p in CONTENT_ROOT.rglob('*.glb'):
        idx.setdefault(p.stem, p)
    return idx


# ── Render-mesh silhouette (preferred) ──────────────────────────────────────
_GLTF_COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2),
              5125: ('I', 4), 5126: ('f', 4)}
_GLTF_TYPEN = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


_GLTF_NPTYPE = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
                5125: np.uint32, 5126: np.float32}


def _gltf_accessor(g, blob, ai):
    a = g.accessors[ai]
    bv = g.bufferViews[a.bufferView]
    base = (bv.byteOffset or 0) + (a.byteOffset or 0)
    fmt, sz = _GLTF_COMP[a.componentType]
    n = _GLTF_TYPEN[a.type]
    dt = _GLTF_NPTYPE[a.componentType]
    stride = bv.byteStride or sz * n
    if stride == sz * n:  # tightly packed — read the whole block in one shot
        flat = np.frombuffer(blob, dtype=dt, count=a.count * n, offset=base)
        return flat.reshape(a.count, n).astype(np.float64 if fmt == 'f' else np.int64)
    # Interleaved (rare): take a strided view of the raw bytes and slice columns.
    raw = np.frombuffer(blob, dtype=np.uint8, count=a.count * stride, offset=base)
    raw = raw.reshape(a.count, stride)[:, : sz * n]
    out = raw.reshape(a.count, sz * n).view(dt).reshape(a.count, n)
    return out.astype(np.float64 if fmt == 'f' else np.int64)


def _glb_tris(path: Path):
    """Return (vertices[N,3], triangles[M,3]) from a .glb."""
    g = GLTF2().load(str(path))
    blob = g.binary_blob()
    verts, faces, off = [], [], 0
    for mesh in g.meshes:
        for prim in mesh.primitives:
            if prim.indices is None or prim.attributes.POSITION is None:
                continue
            pos = _gltf_accessor(g, blob, prim.attributes.POSITION)
            idx = _gltf_accessor(g, blob, prim.indices).reshape(-1).astype(np.int64)
            verts.append(pos)
            faces.append(idx.reshape(-1, 3) + off)
            off += len(pos)
    if not verts:
        return None, None
    return np.vstack(verts), np.vstack(faces)


def _pick_footprint_mesh(named_glb: list[tuple[str, Path]], clearance: dict | None = None):
    """Pick the mesh that defines the footprint: the *non-VAT* mesh with the
    largest SOLID top-down area.

    The structural housing defines the footprint and contains the animated VAT
    geometry inside it, so a single mesh gives the same outer contour as a union
    without the stitching artefacts of merging offset/scaled sub-meshes. We score
    by solid filled area (a coarse raster) rather than vertex count, because a
    skeletal *frame* (e.g. the HUB's beam mesh) has tons of verts but little solid
    surface — that's the "roofless frame" failure. VAT meshes are animated parts
    in an exploded rest pose, so we only consider them if nothing else exists.
    """
    loaded = []
    for name, path in named_glb:
        V, F = _glb_tris(path)
        if V is not None and len(V) >= 3:
            loaded.append((name, V, F))
    if not loaded:
        return None, None
    non_vat = [m for m in loaded if not _is_vat_mesh(m[0])]
    pool = non_vat or loaded

    # Only weigh meshes that are a meaningful fraction of the biggest by 2-D
    # extent — skips tiny decor (the HUB's books/mugs) without rasterising them.
    biggest = max(max(np.ptp(V[:, 0]), np.ptp(V[:, 2])) for _, V, _ in pool)
    cands = [m for m in pool if max(np.ptp(m[1][:, 0]), np.ptp(m[1][:, 2])) >= 0.35 * biggest] or pool

    clearance_area = (clearance['width'] * clearance['depth']) if clearance else None
    best, best_score = None, -1
    for _, V, F in cands:
        r = _rasterize_topdown_height(V[:, 0] * 100.0, V[:, 2] * 100.0, V[:, 1] * 100.0, F, 8.0)
        if r is None:
            continue
        mask = r[1]
        filled = int(mask.sum())
        # Base score = filled × fill-ratio (= filled² / bbox): rewards a mesh that
        # is both sizeable AND solid, so a sparse *frame* (HUB beams) loses.
        score = filled * filled / max(int(mask.size), 1)
        # Clearance penalty: a mesh whose footprint dwarfs the game's clearance box
        # is an appendage, not the building (e.g. the Space Elevator's launch cabin
        # that travels 59 m up). Only bites when choosing between candidates — a
        # single-mesh building like the collider is picked regardless of size.
        if clearance_area:
            bbox_cm2 = (np.ptp(V[:, 0]) * 100) * (np.ptp(V[:, 2]) * 100)
            if bbox_cm2 > 2.5 * clearance_area:
                score *= (2.5 * clearance_area) / bbox_cm2
        if score > best_score:
            best_score, best = score, (V, F)
    if best is None:  # all candidates failed to raster — fall back to vert count
        _, V, F = max(pool, key=lambda m: len(m[1]))
        return V, F
    return best


def outline_from_glb(named_glb: list[tuple[str, Path]], clearance: dict | None) -> list | None:
    """Trace the top-down silhouette from a building's render mesh (.glb)."""
    V, F = _pick_footprint_mesh(named_glb, clearance)
    if V is None:
        return None
    # CUE4Parse glTF: UE_X = gltfX*100, UE_Y = gltfZ*100 (Z-up→Y-up + cm scale).
    P = np.column_stack([V[:, 0] * 100.0, V[:, 2] * 100.0])

    minx, miny = P.min(0) - 30
    maxx, maxy = P.max(0) + 30
    W = int((maxx - minx) / PX_CM) + 1
    H = int((maxy - miny) / PX_CM) + 1
    if W < 2 or H < 2 or W * H > 60_000_000:
        return None

    img = np.zeros((H, W), np.uint8)
    tp = np.empty((len(F), 3, 2), np.int32)
    tp[:, :, 0] = ((P[F][:, :, 0] - minx) / PX_CM).astype(np.int32)
    tp[:, :, 1] = ((P[F][:, :, 1] - miny) / PX_CM).astype(np.int32)
    cv2.fillPoly(img, [t for t in tp], 255)
    k = int(GLB_CLOSE_CM / PX_CM) | 1
    img = cv2.morphologyEx(img, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))

    cnts, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)

    # Solidity guard: reject sparse/fragmented silhouettes (e.g. an exploded VAT
    # mesh with no real housing) — the main contour must hold most of the filled
    # pixels and a fair share of its own bounding box. Such buildings fall back
    # to the collision/box renderer instead of emitting a broken shape.
    total_white = int((img > 0).sum())
    contour_area = cv2.contourArea(c)
    bx, by, bw, bh = cv2.boundingRect(c)
    if total_white == 0 or contour_area / total_white < 0.6 or contour_area / max(bw * bh, 1) < 0.3:
        return None

    # Simplify the contour, escalating tolerance until under the vertex cap
    # (rather than rejecting complex buildings outright).
    eps = GLB_EPS_CM / PX_CM
    for _ in range(8):
        ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(np.float64)
        if len(ap) <= MAX_PTS:
            break
        eps *= 1.5
    if len(ap) < 3:
        return None
    ap[:, 0] = ap[:, 0] * PX_CM + minx
    ap[:, 1] = ap[:, 1] * PX_CM + miny
    poly = Polygon(ap)
    if not poly.is_valid:
        poly = poly.buffer(0)
        if poly.is_empty or poly.geom_type != 'Polygon':
            return None
        ap = np.array(poly.exterior.coords[:-1])

    # On-building sanity check (guards against a stray mesh placed off-origin).
    if clearance:
        ocx, ocy = ap[:, 0].mean(), ap[:, 1].mean()
        span = max(np.ptp(ap[:, 0]), np.ptp(ap[:, 1]), 1.0)
        if math.hypot(ocx - clearance['offsetX'], ocy - clearance['offsetY']) > 0.6 * span:
            return None

    if len(ap) < 3 or len(ap) > MAX_PTS:
        return None
    # Skip near-rectangular silhouettes (box renderer handles them crisply).
    minx, miny, maxx, maxy = poly.bounds
    bbox_area = (maxx - minx) * (maxy - miny)
    if bbox_area > 0 and poly.area / bbox_area >= RECT_FILL:
        return None
    return [[round(float(x), 1), round(float(y), 1)] for x, y in ap]


def _rasterize_topdown_height(X, Y, Zh, F, px_cm):
    """Top-down z-buffer: max mesh height per pixel. Returns (zbuf, mask, minx,
    miny, W, H). Each triangle is rasterised vectorised over its pixel bbox."""
    minx, maxx = X.min(), X.max()
    miny, maxy = Y.min(), Y.max()
    W = int((maxx - minx) / px_cm) + 1
    H = int((maxy - miny) / px_cm) + 1
    if W < 2 or H < 2 or W * H > 4_000_000:
        return None
    zbuf = np.full((H, W), -1e9)
    px = (X - minx) / px_cm
    py = (Y - miny) / px_cm
    for a, b, c in F:
        xs = px[[a, b, c]]
        ys = py[[a, b, c]]
        hs = Zh[[a, b, c]]
        x0 = max(0, int(xs.min())); x1 = min(W - 1, int(xs.max()) + 1)
        y0 = max(0, int(ys.min())); y1 = min(H - 1, int(ys.max()) + 1)
        if x1 < x0 or y1 < y0:
            continue
        d = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(d) < 1e-6:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        wa = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / d
        wb = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / d
        wc = 1 - wa - wb
        inside = (wa >= -0.01) & (wb >= -0.01) & (wc >= -0.01)
        z = wa * hs[0] + wb * hs[1] + wc * hs[2]
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        np.putmask(sub, inside & (z > sub), z)
        zbuf[y0:y1 + 1, x0:x1 + 1] = sub
    mask = zbuf > -1e8
    return zbuf, mask, minx, miny, W, H


def _mask_outline(mask, minx, miny, px_cm, clearance):
    """Outer contour of the relief mask (building-local cm) for hover/hit."""
    m = (mask.astype(np.uint8)) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    eps = GLB_EPS_CM / px_cm
    for _ in range(8):
        ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(np.float64)
        if len(ap) <= MAX_PTS:
            break
        eps *= 1.5
    if len(ap) < 3:
        return None
    ap[:, 0] = ap[:, 0] * px_cm + minx
    ap[:, 1] = ap[:, 1] * px_cm + miny
    return [[round(float(x), 1), round(float(y), 1)] for x, y in ap]


def render_relief(named_glb, clearance, out_path: Path):
    """Render a building's top-down height relief to an RGBA PNG (grayscale
    height+hillshade in RGB, mask in A) for the map to tint. Returns
    (relief_meta, outline) or None when the building is flat/degenerate."""
    V, F = _pick_footprint_mesh(named_glb, clearance)
    if V is None:
        return None
    # CUE4Parse glTF: UE_X = gltfX*100, UE_Y = gltfZ*100, height = gltfY*100.
    X, Y, Zh = V[:, 0] * 100.0, V[:, 2] * 100.0, V[:, 1] * 100.0
    w_cm, d_cm = X.max() - X.min(), Y.max() - Y.min()
    if w_cm < 1 or d_cm < 1:
        return None
    px_cm = max(RELIEF_PX_CM, max(w_cm, d_cm) / RELIEF_MAX_PX)

    r = _rasterize_topdown_height(X, Y, Zh, F, px_cm)
    if r is None:
        return None
    zbuf, mask, minx, miny, W, H = r
    if int(mask.sum()) < 16:
        return None
    lo, hi = zbuf[mask].min(), zbuf[mask].max()
    if hi - lo < RELIEF_MIN_H_CM:      # flat (foundation/wall) — not worth relief
        return None

    h = np.zeros((H, W))
    h[mask] = (zbuf[mask] - lo) / (hi - lo)
    # The map multiplies the category tint × this grayscale, so it has to stay
    # bright or vibrant oranges/yellows turn to mud — but it also needs height
    # contrast. We get both by keeping a HIGH baseline (open surfaces ≈ full tint)
    # and putting the contrast where it doesn't desaturate the colour:
    #   • AO (ambient occlusion): darken only pixels that sit lower than their
    #     local neighbourhood — crevices, seams, gaps between parts.
    #   • a gentle height term so lower *elevations* recede a little.
    #   • emboss: signed height-gradient edge shading for definition.
    # (Balanced "option 3": mean ~0.74, full contrast in the recesses.)
    grad_y, grad_x = np.gradient(h)
    emboss = (grad_y - grad_x) * 3.5
    blur = cv2.GaussianBlur(h.astype(np.float32), (0, 0), sigmaX=max(2.0, W / 12.0))
    ao = np.clip(h - blur, -0.5, 0.0)
    val = np.clip(0.96 + ao * 2.2 + (h - 1.0) * 0.24 + emboss * 0.225, 0.42, 1.0)
    val[~mask] = 0.0
    gray = (val * 255).astype(np.uint8)
    alpha = (mask * 255).astype(np.uint8)
    # cv2 writes 4-channel as BGRA; channels are equal grayscale so order is moot.
    bgra = np.dstack([gray, gray, gray, alpha])

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), bgra)

    outline = _mask_outline(mask, minx, miny, px_cm, clearance)
    relief = {
        'w': round(float(w_cm), 1), 'd': round(float(d_cm), 1),
        'cx': round(float((X.min() + X.max()) / 2), 1),
        'cy': round(float((Y.min() + Y.max()) / 2), 1),
        'pw': W, 'ph': H,
    }
    return relief, outline


def agg_polys_from_mesh(mesh_json: Path) -> list[Polygon]:
    """Project a mesh's BodySetup collision pieces to grid-snapped XY rectangles.

    Each convex piece becomes its axis-aligned bounding rectangle (the buildings
    are rectilinear, so this is both accurate and keeps crisp right angles). Boxes
    that happen to be rotated by a non-90° yaw (rare; angled supports) keep their
    orientation; everything else snaps to the grid.
    """
    try:
        data = json.loads(mesh_json.read_text())
    except Exception:
        return []
    polys: list[Polygon] = []
    for e in data:
        if e.get('Type') != 'BodySetup':
            continue
        agg = (e.get('Properties') or {}).get('AggGeom') or {}
        for ce in agg.get('ConvexElems', []) or []:
            eb = ce.get('ElemBox') or {}
            mn, mx = eb.get('Min'), eb.get('Max')
            if not (mn and mx):
                pts = [(v['X'], v['Y']) for v in ce.get('VertexData', []) or []]
                if len(pts) < 3:
                    continue
                b = Polygon(pts).bounds
                mn, mx = {'X': b[0], 'Y': b[1]}, {'X': b[2], 'Y': b[3]}
            r = shbox(_snap(mn['X']), _snap(mn['Y']), _snap(mx['X']), _snap(mx['Y']))
            if r.area > 1:
                polys.append(r)
        for be in agg.get('BoxElems', []) or []:
            hx, hy = be.get('X', 0) / 2, be.get('Y', 0) / 2
            if hx <= 0 or hy <= 0:
                continue
            yaw = (be.get('Rotation') or {}).get('Yaw', 0.0)
            c = be.get('Center') or {}
            cx, cy = c.get('X', 0.0), c.get('Y', 0.0)
            if 2 < (yaw % 90) < 88:  # genuinely angled — keep the orientation
                r = shtranslate(shrotate(shbox(-hx, -hy, hx, hy), yaw, origin=(0, 0)), cx, cy)
            else:
                if (yaw % 180) > 45:  # ~90°: swap extents, stays axis-aligned
                    hx, hy = hy, hx
                r = shbox(_snap(cx - hx), _snap(cy - hy), _snap(cx + hx), _snap(cy + hy))
            if r.area > 1:
                polys.append(r)
    return polys


def _clean_rectilinear(poly: Polygon) -> Polygon:
    """Snap vertices to the grid and drop duplicate/collinear points so the ring
    is the minimal set of corners (keeps right angles, no DP diagonals)."""
    coords = [(_snap(x), _snap(y)) for x, y in poly.exterior.coords[:-1]]
    dedup = []
    for p in coords:
        if not dedup or dedup[-1] != p:
            dedup.append(p)
    if len(dedup) > 1 and dedup[0] == dedup[-1]:
        dedup.pop()
    n = len(dedup)
    res = []
    for i in range(n):
        a, b, c = dedup[i - 1], dedup[i], dedup[(i + 1) % n]
        cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(cross) > 1:
            res.append(b)
    return Polygon(res) if len(res) >= 3 else poly


def outline_from_meshes(mesh_paths: list[Path], clearance: dict | None) -> list | None:
    polys: list[Polygon] = []
    for mp in mesh_paths:
        polys.extend(agg_polys_from_mesh(mp))
    if not polys:
        return None

    # Drop tiny pieces (bolts/pins) and thin elongated ones (railings, catwalks)
    # that otherwise stick out of the silhouette as spurious wings.
    amax = max(p.area for p in polys)
    kept = []
    for p in polys:
        if p.area < 0.03 * amax:
            continue
        bx = p.bounds
        w, h = bx[2] - bx[0], bx[3] - bx[1]
        mn_dim = min(w, h)
        aspect = max(w, h) / mn_dim if mn_dim > 0 else 99
        if mn_dim < 90 and aspect > 5 and p.area < 0.20 * amax:
            continue
        kept.append(p)
    if not kept:
        kept = polys

    try:
        u = unary_union(kept)
        # Morphological open then close with mitre (square) joins: the open strips
        # thin appendages, the close refills thin notches — both keep 90° corners.
        opened = u.buffer(-OPEN_CM, join_style=2).buffer(OPEN_CM, join_style=2)
        if not opened.is_empty:
            u = opened
        u = u.buffer(OPEN_CM, join_style=2).buffer(-OPEN_CM, join_style=2)
    except Exception:
        return None
    if u.is_empty:
        return None
    if isinstance(u, MultiPolygon):
        u = max(u.geoms, key=lambda g: g.area)
    if u.geom_type != 'Polygon' or u.area <= 1.0:
        return None

    # Sanity-check against the clearance box: a valid silhouette should sit *on*
    # the building, not somewhere else. The collision mesh is routinely LARGER
    # than the clearance box (clearance is placement spacing, not visual extent —
    # e.g. the refinery's catwalks overhang it), so we don't cap the outline size
    # to the clearance; we only reject outlines that are off-center (a stray
    # sub-mesh with its own offset) or absurdly large (grabbed the wrong mesh).
    if clearance:
        minx, miny, maxx, maxy = u.bounds
        ocx, ocy = (minx + maxx) / 2, (miny + maxy) / 2
        outline_span = max(maxx - minx, maxy - miny, 1.0)
        if math.hypot(ocx - clearance['offsetX'], ocy - clearance['offsetY']) > 0.6 * outline_span:
            return None
        if u.area > 8.0 * max(clearance['width'] * clearance['depth'], 1.0):
            return None

    u = _clean_rectilinear(u)
    if u.geom_type != 'Polygon' or u.area <= 1.0:
        return None

    coords = list(u.exterior.coords)[:-1]  # drop the closing dup point
    if len(coords) < 3 or len(coords) > MAX_PTS:
        return None

    # Skip near-rectangular outlines: the box renderer draws them crisply and we
    # save the payload + texture bake. (Compare outline area to its bbox area.)
    minx, miny, maxx, maxy = u.bounds
    bbox_area = (maxx - minx) * (maxy - miny)
    if bbox_area > 0 and u.area / bbox_area >= RECT_FILL:
        return None

    return [[round(x, 1), round(y, 1)] for x, y in coords]


def main():
    mesh_idx = index_meshes()
    glb_idx = index_glb()
    print(f'Indexed {len(mesh_idx)} mesh/object jsons, {len(glb_idx)} render meshes (.glb).')

    out: dict[str, dict] = {}

    # Clear stale relief PNGs so removed/renamed buildings don't leave orphans.
    if RELIEF_DIR.exists():
        for old in RELIEF_DIR.glob('*.png'):
            old.unlink()
    RELIEF_DIR.mkdir(parents=True, exist_ok=True)

    build_jsons = sorted(BUILDABLE_ROOT.rglob('Build_*.json')) + sorted(BUILDABLE_ROOT.rglob('BUILD_*.json'))
    print(f'Scanning {len(build_jsons)} Build_*.json files...')

    missing_box = []
    from_relief = 0
    from_glb = 0
    from_collision = 0
    for i, path in enumerate(build_jsons):
        cls = path.stem  # e.g. "Build_SmelterMk1"

        try:
            raw = path.read_text()
            data = json.loads(raw)
        except Exception:
            continue

        footprint = None
        for entry in data:
            cd = (entry.get('Properties') or {}).get('mClearanceData')
            if cd:
                footprint = footprint_from_clearance(cd[0])
                break

        rec = footprint if footprint else dict(DEFAULT_FOOTPRINT)
        if not footprint:
            missing_box.append(cls)

        mesh_names = list(dict.fromkeys(_MESH_REF_RE.findall(raw)))  # dedup, keep order
        glb_named = [(n, glb_idx[n]) for n in mesh_names if n in glb_idx]

        outline = None
        relief = None
        # 1. Height relief image (best) from the render mesh.
        if glb_named:
            try:
                res = render_relief(glb_named, footprint, RELIEF_DIR / f'{cls}.png')
            except Exception as e:
                print(f'  ! relief failed for {cls}: {e}')
                res = None
            if res:
                relief, outline = res
                from_relief += 1
            else:
                # 2. Flat-but-shaped render mesh → solid silhouette polygon.
                try:
                    outline = outline_from_glb(glb_named, footprint)
                except Exception as e:
                    print(f'  ! glb outline failed for {cls}: {e}')
                if outline:
                    from_glb += 1
        # 3. No render mesh → collision geometry.
        if outline is None and relief is None:
            mesh_paths = [mesh_idx[n] for n in mesh_names if n in mesh_idx]
            outline = outline_from_meshes(mesh_paths, footprint) if mesh_paths else None
            if outline:
                from_collision += 1

        if outline or relief:
            rec = dict(rec)
            if outline:
                rec['outline'] = outline
            if relief:
                rec['relief'] = relief

        out[cls] = rec
        if (i + 1) % 100 == 0:
            print(f'  ...{i + 1}/{len(build_jsons)} ({from_relief} relief so far)')

    out = dict(sorted(out.items()))

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=2))
    shaped = from_relief + from_glb + from_collision
    print(f'Wrote {len(out)} entries to {OUT_FILE}')
    print(f'  {from_relief} height-relief images, {from_glb} render-mesh outlines, '
          f'{from_collision} collision outlines; {len(out) - shaped} box')
    print(f'  relief PNGs in {RELIEF_DIR}')
    print(f'  {len(missing_box)} fell back to the default box (no usable mClearanceData)')

    print('\nSample entries:')
    for s in ['Build_SmelterMk1', 'Build_ConstructorMk1', 'Build_AssemblerMk1',
              'Build_ManufacturerMk1', 'Build_OilRefinery', 'Build_Blender',
              'Build_Foundation_8x1_01', 'Build_HadronCollider', 'Build_MinerMk1']:
        e = out.get(s)
        if not e:
            print(f'  {s}: (not found)')
        else:
            n = len(e['outline']) if 'outline' in e else 0
            print(f"  {s}: box {e['width']}x{e['depth']}  outline pts: {n if n else '— (box)'}")


if __name__ == '__main__':
    main()
