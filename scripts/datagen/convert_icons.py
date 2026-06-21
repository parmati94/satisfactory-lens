#!/usr/bin/env python3
"""
Convert Satisfactory .uasset + .ubulk texture pairs to PNG.
Handles DXT1, DXT5, BC4, BC5, BC7, B8G8R8A8 formats.
"""

import json
import struct
import sys
import os
from pathlib import Path
import texture2ddecoder
from PIL import Image

FORMAT_MAP = {
    'PF_DXT1':      ('dxt1',     8),
    'PF_DXT5':      ('dxt5',    16),
    'PF_BC4':       ('bc4',      8),
    'PF_BC5':       ('bc5',     16),
    'PF_BC6H':      ('bc6',     16),
    'PF_BC7':       ('bc7',     16),
    'PF_B8G8R8A8':  ('raw_bgra', 4),   # 4 bytes per pixel, uncompressed
}

def read_uasset_format(uasset_path):
    data = Path(uasset_path).read_bytes()
    text = data.decode('latin-1')
    for fmt in FORMAT_MAP:
        if fmt in text:
            return fmt
    return None

def find_dimensions(uasset_path):
    """
    Search the uasset binary for the IntPoint (width, height) stored as two
    consecutive int32s near 'ImportedSize' in the property table.
    Falls back to guessing from the filename.
    """
    data = Path(uasset_path).read_bytes()
    marker = b'ImportedSize'
    idx = data.find(marker)
    if idx != -1:
        # The IntPoint value follows the property name tag — scan nearby bytes
        # for a plausible power-of-two width/height pair.
        for offset in range(idx + len(marker), min(idx + len(marker) + 64, len(data) - 8), 1):
            w, h = struct.unpack_from('<ii', data, offset)
            if w > 0 and h > 0 and w <= 4096 and h <= 4096:
                if (w & (w - 1)) == 0 and (h & (h - 1)) == 0:
                    return w, h

    # Fallback: infer from filename (e.g. "...256.uasset" → 256x256)
    stem = Path(uasset_path).stem
    for part in stem.split('_'):
        try:
            n = int(part)
            if n in (64, 128, 256, 512, 1024):
                return n, n
        except ValueError:
            pass
    return None, None

def decode_texture(fmt_name, raw, width, height):
    # PF_B8G8R8A8 is uncompressed — 4 bytes per pixel, no block structure
    if fmt_name == 'PF_B8G8R8A8':
        raw = raw[:width * height * 4]
        return Image.frombytes('RGBA', (width, height), raw, 'raw', 'BGRA')

    bpp = FORMAT_MAP[fmt_name][1]
    expected = (width // 4) * (height // 4) * bpp
    raw = raw[:expected]

    if fmt_name == 'PF_DXT1':
        rgba = texture2ddecoder.decode_bc1(raw, width, height)
    elif fmt_name == 'PF_DXT5':
        rgba = texture2ddecoder.decode_bc3(raw, width, height)
    elif fmt_name == 'PF_BC4':
        rgba = texture2ddecoder.decode_bc4(raw, width, height)
    elif fmt_name == 'PF_BC5':
        rgba = texture2ddecoder.decode_bc5(raw, width, height)
    elif fmt_name == 'PF_BC6H':
        rgba = texture2ddecoder.decode_bc6(raw, width, height)
    elif fmt_name == 'PF_BC7':
        rgba = texture2ddecoder.decode_bc7(raw, width, height)
    else:
        raise ValueError(f'Unsupported format: {fmt_name}')

    return Image.frombytes('RGBA', (width, height), rgba, 'raw', 'BGRA')

def convert_inline(uasset_path, out_path):
    """
    Decode a texture whose largest mip is stored inline in the .uasset
    (BULKDATA_ForceInlinePayload). Falls back gracefully if no inline mip found.
    """
    icon_json = Path(uasset_path).with_suffix('.json')
    if not icon_json.exists():
        return False

    try:
        meta = json.loads(icon_json.read_text())
    except Exception:
        return False

    raw_uasset = Path(uasset_path).read_bytes()

    for entry in meta:
        px_fmt = entry.get('PixelFormat')
        if not px_fmt or px_fmt not in FORMAT_MAP:
            continue

        for mip in entry.get('Mips', []):
            bd = mip.get('BulkData', {})
            if 'ForceInlinePayload' not in bd.get('BulkDataFlags', ''):
                continue

            width  = mip.get('SizeX', 0)
            height = mip.get('SizeY', 0)
            size   = bd.get('SizeOnDisk', 0)
            offset_raw = bd.get('OffsetInFile', '0')
            try:
                offset = int(offset_raw, 16) if str(offset_raw).startswith('0x') else int(offset_raw)
            except Exception:
                continue

            raw = raw_uasset[offset:offset + size]
            if len(raw) < size:
                continue

            try:
                img = decode_texture(px_fmt, bytes(raw), width, height)
                Path(out_path).parent.mkdir(parents=True, exist_ok=True)
                img.save(out_path)
                print(f'  OK    {Path(out_path).name}  ({px_fmt} {width}x{height} inline)')
                return True
            except Exception as e:
                print(f'  FAIL  {uasset_path} (inline {width}x{height}): {e}')

    return False


def convert(uasset_path, out_path):
    ubulk_path = Path(uasset_path).with_suffix('.ubulk')
    if not ubulk_path.exists():
        print(f'  SKIP  {uasset_path} — no .ubulk sidecar')
        return False

    fmt = read_uasset_format(uasset_path)
    if not fmt:
        print(f'  SKIP  {uasset_path} — unknown format')
        return False

    width, height = find_dimensions(uasset_path)
    if not width:
        print(f'  SKIP  {uasset_path} — could not determine dimensions')
        return False

    raw = ubulk_path.read_bytes()
    try:
        img = decode_texture(fmt, raw, width, height)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        img.save(out_path)
        print(f'  OK    {Path(out_path).name}  ({fmt} {width}x{height})')
        return True
    except Exception as e:
        print(f'  FAIL  {uasset_path}: {e}')
        return False


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: convert_icons.py <input_dir> <output_dir>')
        print('  Finds all .uasset files in input_dir and converts to PNG in output_dir')
        sys.exit(1)

    in_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    uassets = list(in_dir.rglob('*.uasset'))
    print(f'Found {len(uassets)} .uasset files in {in_dir}')

    ok = fail = skip = 0
    for ua in uassets:
        rel = ua.relative_to(in_dir)
        out = out_dir / rel.with_suffix('.png')
        result = convert(ua, out)
        if result is True:
            ok += 1
        elif result is False:
            # distinguish skip vs fail by checking if ubulk exists
            if Path(ua).with_suffix('.ubulk').exists():
                fail += 1
            else:
                skip += 1

    print(f'\nDone: {ok} converted, {skip} skipped (no ubulk), {fail} failed')
