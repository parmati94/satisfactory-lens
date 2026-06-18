import zlib from 'zlib';
import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

const MAP_MGR_PATH = '/Script/FactoryGame.FGMapManager';

// The game stores the map's fog-of-war as a 512×512 RGBA byte texture on
// FGMapManager.mFogOfWarRawData. Only the blue channel carries the reveal
// amount (0 = never explored); red/green are always 0 and alpha always 255.
// The texture's pixel grid maps directly onto the playable world bounds with
// the same orientation as our map tiles (column = west→east, row = north→south).
const FOG_DIM = 512;
const FOG_BYTES = FOG_DIM * FOG_DIM * 4;

// The blue channel ramps 0→~128 as a soft reveal brush is painted around each
// visited point, then plateaus at a 128–151 "fully explored" core. The faint
// low-value penumbra is just brush antialiasing, not actually-revealed terrain:
// treating any non-zero value as explored floods it into one big round blob.
// The game instead shows crisp lobes, so we smoothstep the value between two
// thresholds — below REVEAL_LO stays black, above REVEAL_HI is fully clear,
// with a narrow soft edge between (further softened by Leaflet's upscale).
const REVEAL_LO = 88;
const REVEAL_HI = 136;

/**
 * Pull the blue (reveal-amount) channel out of the fog texture as a flat
 * 512×512 array. Returns null when the save has no fog data.
 */
function extractFogReveal(save: SatisfactorySave): Uint8Array | null {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.typePath !== MAP_MGR_PATH) continue;
      const raw = (obj.properties as any)['mFogOfWarRawData']?.values as number[] | undefined;
      if (!raw || raw.length < FOG_BYTES) continue;
      const reveal = new Uint8Array(FOG_DIM * FOG_DIM);
      for (let i = 0; i < reveal.length; i++) reveal[i] = raw[i * 4 + 2]; // blue channel
      return reveal;
    }
  }
  return null;
}

/**
 * Render the reveal channel as a grayscale+alpha PNG: opaque black where never
 * explored, fading to fully transparent over the explored core. Leaflet scales
 * this 512px image up over the map bounds, so the bilinear upscale further
 * softens the edge.
 */
function renderFogPng(reveal: Uint8Array): Buffer {
  const w = FOG_DIM;
  const h = FOG_DIM;
  // Precompute the reveal→alpha curve once: smoothstep the reveal value across
  // [REVEAL_LO, REVEAL_HI] to get "explored-ness", then invert into fog opacity.
  const alphaFor = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.max(0, Math.min(1, (v - REVEAL_LO) / (REVEAL_HI - REVEAL_LO)));
    const explored = t * t * (3 - 2 * t); // smoothstep
    alphaFor[v] = Math.round((1 - explored) * 255);
  }
  // Raw scanlines: a filter byte (0 = none) then w pixels of (gray, alpha).
  const raw = Buffer.allocUnsafe(h * (1 + w * 2));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      raw[p++] = 0;                          // gray = black
      raw[p++] = alphaFor[reveal[y * w + x]]; // explored → transparent
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return buildPng(w, h, 4 /* grayscale + alpha */, idat);
}

function buildPng(width: number, height: number, colorType: number, idatData: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = colorType;  // 4 = grayscale + alpha
  ihdr[10] = 0;         // compression: deflate
  ihdr[11] = 0;         // filter method
  ihdr[12] = 0;         // interlace: none
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Extracting + rendering walks every object in the save, so memoize per loaded
// save — the overlay image is requested once per session but reloads share it.
let cache: { save: SatisfactorySave; png: Buffer | null } | null = null;

/** Discovered-area fog overlay as a PNG buffer, or null if the save has no fog data. */
export function getFogPng(save: SatisfactorySave): Buffer | null {
  if (cache?.save === save) return cache.png;
  const reveal = extractFogReveal(save);
  const png = reveal ? renderFogPng(reveal) : null;
  cache = { save, png };
  return png;
}
