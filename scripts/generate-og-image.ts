import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { NodeFileMapProvider } from '../src/server/NodeFileProvider';
import { buildStarterCache } from '../src/shared/cache/StarterCacheBuilder';
import { MemoryFileMapProvider, OsrsUnifiedCache } from '../src/shared/cache/UnifiedCacheLoader';
import {
  BitmapFont,
  drawBitmapText,
  FONT_PLAIN_12,
  FONT_QUILL_8,
  measureBitmapText,
} from '../src/shared/constants/bitmapFonts';
import { renderChatbox, upscaleNearest } from '../src/shared/renderer/ChatboxRenderer';
import { renderAnimatedFramePair, resolveNpcChathead } from '../src/shared/renderer/ChatheadPipeline';

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return chunk;
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0; // filter None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowOff + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cIhdr = makePngChunk('IHDR', ihdr);
  const cIdat = makePngChunk('IDAT', idat);
  const cIend = makePngChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(sig.length + cIhdr.length + cIdat.length + cIend.length);
  let pos = 0;
  for (const part of [sig, cIhdr, cIdat, cIend]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function blendPixel(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number
): void {
  if (x < 0 || x >= canvasWidth || y < 0 || y >= canvasHeight || a <= 0) return;
  const idx = (y * canvasWidth + x) * 4;
  if (a >= 255) {
    canvas[idx] = r;
    canvas[idx + 1] = g;
    canvas[idx + 2] = b;
    canvas[idx + 3] = 255;
    return;
  }
  const alpha = a / 255;
  const inv = 1 - alpha;
  canvas[idx] = Math.round(r * alpha + canvas[idx] * inv);
  canvas[idx + 1] = Math.round(g * alpha + canvas[idx + 1] * inv);
  canvas[idx + 2] = Math.round(b * alpha + canvas[idx + 2] * inv);
  canvas[idx + 3] = 255;
}

function fillRect(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(canvasWidth, x + w);
  const y1 = Math.min(canvasHeight, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      blendPixel(canvas, canvasWidth, canvasHeight, px, py, r, g, b, a);
    }
  }
}

function strokeRect(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
  r: number,
  g: number,
  b: number,
  a = 255
): void {
  fillRect(canvas, canvasWidth, canvasHeight, x, y, w, thickness, r, g, b, a);
  fillRect(canvas, canvasWidth, canvasHeight, x, y + h - thickness, w, thickness, r, g, b, a);
  fillRect(canvas, canvasWidth, canvasHeight, x, y, thickness, h, r, g, b, a);
  fillRect(canvas, canvasWidth, canvasHeight, x + w - thickness, y, thickness, h, r, g, b, a);
}

function blitRgba(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  src: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  dstX: number,
  dstY: number
): void {
  for (let sy = 0; sy < srcHeight; sy++) {
    const dy = dstY + sy;
    if (dy < 0 || dy >= canvasHeight) continue;
    for (let sx = 0; sx < srcWidth; sx++) {
      const dx = dstX + sx;
      if (dx < 0 || dx >= canvasWidth) continue;
      const sIdx = (sy * srcWidth + sx) * 4;
      const sa = src[sIdx + 3];
      if (sa === 0) continue;
      blendPixel(canvas, canvasWidth, canvasHeight, dx, dy, src[sIdx], src[sIdx + 1], src[sIdx + 2], sa);
    }
  }
}

function renderCenteredScaledBitmapText(
  canvas: Uint8ClampedArray,
  text: string,
  font: BitmapFont,
  color: number,
  preferredScale: number,
  maxWidth: number,
  centerX: number,
  topY: number
): void {
  const nativeWidth = Math.max(1, measureBitmapText(text, font) + 4);
  const nativeHeight = font.lineHeight + 6;
  let scale = preferredScale;
  while (scale > 1 && nativeWidth * scale > maxWidth) {
    scale--;
  }

  const buf = new Uint8ClampedArray(nativeWidth * nativeHeight * 4);
  drawBitmapText(buf, nativeWidth, nativeHeight, text, Math.floor(nativeWidth / 2), 2, font, color, true);
  const scaled = scale > 1 ? upscaleNearest(buf, nativeWidth, nativeHeight, scale) : {
    width: nativeWidth,
    height: nativeHeight,
    pixels: buf,
  };
  const dstX = Math.round(centerX - scaled.width / 2);
  blitRgba(canvas, OG_WIDTH, OG_HEIGHT, scaled.pixels, scaled.width, scaled.height, dstX, topY);
}

async function openPreferredCache(): Promise<OsrsUnifiedCache> {
  const diskDir = path.resolve(process.cwd(), 'cache');
  try {
    const cache = await OsrsUnifiedCache.open(new NodeFileMapProvider(diskDir), './cache');
    const summary = await cache.getSummary();
    if (summary.npcCount > 0) {
      return cache;
    }
  } catch {
    // Fall back to starter cache if ./cache is unavailable
  }
  const built = buildStarterCache();
  return OsrsUnifiedCache.open(new MemoryFileMapProvider(built.dat2Files.entries()), 'starter-dat2');
}

async function main(): Promise<void> {
  const cache = await openPreferredCache();

  let npc = await cache.getNpc(2108); // Wise Old Man
  if (!npc || npc.chatheadModels.length === 0) {
    npc = (await cache.getNpc(3105)) ?? (await cache.getNpc(3106)); // Hans
  }
  if (!npc) {
    const all = await cache.getAllNpcs();
    npc = all.find((n) => n.chatheadModels.length > 0);
  }
  if (!npc) {
    throw new Error('Could not find any NPC with chathead models in cache.');
  }

  const resolved = await resolveNpcChathead(cache, npc);
  if (!resolved) {
    throw new Error(`Failed to resolve chathead for NPC #${npc.id} (${npc.name}).`);
  }

  const pair = await renderAnimatedFramePair(cache, resolved.mesh, resolved.defaultCamera, null, 0, 96, 2);
  const chatbox = renderChatbox(pair.regular, {
    speakerName: npc.name,
    dialogueText: 'Generate authentic <col=000080>OSRS 3D chatheads</col>, animated GIFs, and dialogue boxes!',
    promptText: 'Click here to continue',
    showPrompt: true,
    layout: 'npc-left',
    scale: 2,
  });

  const canvas = new Uint8ClampedArray(OG_WIDTH * OG_HEIGHT * 4);

  // Dark OSRS studio vertical gradient (#221d16 -> #13100c)
  for (let y = 0; y < OG_HEIGHT; y++) {
    const t = y / (OG_HEIGHT - 1);
    const r = Math.round(0x22 + (0x13 - 0x22) * t);
    const g = Math.round(0x1d + (0x10 - 0x1d) * t);
    const b = Math.round(0x16 + (0x0c - 0x16) * t);
    for (let x = 0; x < OG_WIDTH; x++) {
      const idx = (y * OG_WIDTH + x) * 4;
      canvas[idx] = r;
      canvas[idx + 1] = g;
      canvas[idx + 2] = b;
      canvas[idx + 3] = 255;
    }
  }

  // Inner framed panel (#1f1b16 fill, 2px #695944 border, 3px #f0b93d top accent bar)
  const panelX = 32;
  const panelY = 32;
  const panelW = OG_WIDTH - 64;
  const panelH = OG_HEIGHT - 64;
  fillRect(canvas, OG_WIDTH, OG_HEIGHT, panelX, panelY, panelW, panelH, 0x1f, 0x1b, 0x16, 255);
  strokeRect(canvas, OG_WIDTH, OG_HEIGHT, panelX, panelY, panelW, panelH, 2, 0x69, 0x59, 0x44, 255);
  fillRect(canvas, OG_WIDTH, OG_HEIGHT, panelX, panelY, panelW, 3, 0xf0, 0xb9, 0x3d, 255);

  const centerX = OG_WIDTH / 2;

  renderCenteredScaledBitmapText(
    canvas,
    'OSRS Chathead & Dialogue Generator',
    FONT_QUILL_8,
    0xf0b93d,
    3,
    1100,
    centerX,
    66
  );

  renderCenteredScaledBitmapText(
    canvas,
    'Authentic 3D Software Rasterizer  |  519x142 Chatboxes  |  Animated GIF & PNG',
    FONT_PLAIN_12,
    0xb8aa93,
    2,
    1100,
    centerX,
    148
  );

  const boxX = Math.round((OG_WIDTH - chatbox.width) / 2);
  const boxY = 212;
  fillRect(canvas, OG_WIDTH, OG_HEIGHT, boxX + 6, boxY + 10, chatbox.width, chatbox.height, 0, 0, 0, 115);
  blitRgba(canvas, OG_WIDTH, OG_HEIGHT, chatbox.pixels, chatbox.width, chatbox.height, boxX, boxY);

  renderCenteredScaledBitmapText(
    canvas,
    'NPCs  |  Players & Hiscores  |  Custom Caches  |  Transparent Exports',
    FONT_PLAIN_12,
    0xd4c7b0,
    2,
    1100,
    centerX,
    534
  );

  const pngBytes = encodeRgbaPng(OG_WIDTH, OG_HEIGHT, canvas);
  const outDir = path.resolve(process.cwd(), 'public');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'og-image.png');
  await fs.writeFile(outPath, pngBytes);
  console.log(`Generated ${outPath} (${OG_WIDTH}x${OG_HEIGHT}, ${pngBytes.length} bytes) using NPC #${npc.id} (${npc.name}).`);
}

void main();
