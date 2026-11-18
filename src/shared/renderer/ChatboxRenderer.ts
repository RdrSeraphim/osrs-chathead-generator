import {
  drawBitmapText,
  FONT_QUILL_8,
  wrapBitmapText,
} from '../constants/bitmapFonts';
import { RasterOutput } from './SoftwareRasterizer';

export const CHATBOX_WIDTH = 519;
export const CHATBOX_HEIGHT = 142;

export type ChatboxLayout = 'npc-left' | 'player-right' | 'none';

export interface ChatboxOptions {
  speakerName: string;
  dialogueText: string;
  promptText?: string;
  showPrompt?: boolean;
  layout: ChatboxLayout;
  scale?: number;
  nameColor?: number;
  textColor?: number;
  promptColor?: number;
}

// Precomputed deterministic 519x142 authentic OSRS parchment + stone border backdrop
let cachedBackdrop: Uint8ClampedArray | null = null;

function hash2d(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  n = (n ^ (n >>> 13)) * 1274126177;
  return (n ^ (n >>> 16)) & 0xff;
}

function getChatboxBackdrop(): Uint8ClampedArray {
  if (cachedBackdrop) return cachedBackdrop;

  const w = CHATBOX_WIDTH;
  const h = CHATBOX_HEIGHT;
  const buf = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const distEdge = Math.min(x, y, w - 1 - x, h - 1 - y);

      if (distEdge <= 5) {
        // Authentic OSRS stone/wood beveled border around chatbox
        const isTopLeft = x < 6 || y < 6;
        let r = 82, g = 74, b = 61; // #524a3d
        if (distEdge === 0 || distEdge === 5) {
          r = 56; g = 48; b = 35; // #383023 dark outline
        } else if (distEdge === 1) {
          r = isTopLeft ? 132 : 70;
          g = isTopLeft ? 120 : 62;
          b = isTopLeft ? 100 : 50;
        } else if (distEdge === 4) {
          r = isTopLeft ? 64 : 112;
          g = isTopLeft ? 56 : 100;
          b = isTopLeft ? 44 : 82;
        } else {
          const grain = (hash2d(x, y) & 7) - 3;
          r = 94 + grain;
          g = 84 + grain;
          b = 69 + grain;
        }
        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = 255;
        continue;
      }

      // Inner bevel shadow
      if (distEdge === 6) {
        buf[idx] = 178;
        buf[idx + 1] = 160;
        buf[idx + 2] = 128;
        buf[idx + 3] = 255;
        continue;
      }

      // Authentic OSRS parchment tone (#d4c2a1 .. #c5b28e) with subtle warm paper mottling
      const n1 = hash2d(x >> 2, y >> 2);
      const n2 = hash2d(x, y);
      const blotch = ((n1 - 128) >> 4) + ((n2 - 128) >> 5);
      // Slight vignette darkening near edges
      const edgeTint = distEdge < 14 ? -(14 - distEdge) * 0.7 : 0;
      const delta = Math.round(blotch + edgeTint);

      buf[idx] = Math.min(255, Math.max(0, 212 + delta));
      buf[idx + 1] = Math.min(255, Math.max(0, 193 + delta));
      buf[idx + 2] = Math.min(255, Math.max(0, 157 + Math.round(delta * 0.85)));
      buf[idx + 3] = 255;
    }
  }

  cachedBackdrop = buf;
  return buf;
}

/**
 * Render an authentic 519x142 OSRS dialogue chatbox (scaled cleanly with nearest-neighbor).
 */
export function renderChatbox(
  chathead: RasterOutput | null,
  options: ChatboxOptions
): RasterOutput {
  const native = new Uint8ClampedArray(getChatboxBackdrop());
  const w = CHATBOX_WIDTH;
  const h = CHATBOX_HEIGHT;

  // Blit chathead into the authentic 96x96 Interface 231/217 slot (clipped to x: 19..114 or 402..497, y: 22..117)
  if (chathead && options.layout !== 'none') {
    const slotX = options.layout === 'npc-left' ? 19 : 402;
    const slotY = 22;
    const nativeBoxSize = 96;

    const srcW = chathead.width;
    const srcH = chathead.height;
    for (let dy = 0; dy < nativeBoxSize; dy++) {
      const py = slotY + dy;
      if (py < 7 || py >= h - 7) continue;
      const sy = Math.min(srcH - 1, Math.floor((dy * srcH) / nativeBoxSize));
      for (let dx = 0; dx < nativeBoxSize; dx++) {
        const px = slotX + dx;
        if (px < 7 || px >= w - 7) continue;
        const sx = Math.min(srcW - 1, Math.floor((dx * srcW) / nativeBoxSize));
        const sIdx = (sy * srcW + sx) * 4;
        const sa = chathead.pixels[sIdx + 3];
        if (sa === 0) continue;

        const dIdx = (py * w + px) * 4;
        if (sa >= 255) {
          native[dIdx] = chathead.pixels[sIdx];
          native[dIdx + 1] = chathead.pixels[sIdx + 1];
          native[dIdx + 2] = chathead.pixels[sIdx + 2];
          native[dIdx + 3] = 255;
        } else {
          const a = sa / 255;
          const inv = 1 - a;
          native[dIdx] = Math.round(chathead.pixels[sIdx] * a + native[dIdx] * inv);
          native[dIdx + 1] = Math.round(chathead.pixels[sIdx + 1] * a + native[dIdx + 1] * inv);
          native[dIdx + 2] = Math.round(chathead.pixels[sIdx + 2] * a + native[dIdx + 2] * inv);
        }
      }
    }
  }

  // Compute text box area matching Interface 231 / 217
  let textLeft = 18;
  let textRight = 501;
  if (options.layout === 'npc-left') {
    textLeft = 115;
    textRight = 495;
  } else if (options.layout === 'player-right') {
    textLeft = 24;
    textRight = 404;
  }

  const textCenterX = Math.round((textLeft + textRight) / 2);
  const maxTextWidth = textRight - textLeft;

  const nameColor = options.nameColor ?? 0x800000;
  const textColor = options.textColor ?? 0x000000;
  const promptColor = options.promptColor ?? 0x0000ff;

  // Speaker Name (231:4 / 217:4 -> fontId 497 q8_full)
  if (options.speakerName.trim().length > 0) {
    drawBitmapText(
      native,
      w,
      h,
      options.speakerName.trim(),
      textCenterX,
      22,
      FONT_QUILL_8,
      nameColor,
      false
    );
  }

  // Dialogue Body Lines (231:6 / 217:6 -> fontId 497 q8_full, max 4 lines vertically centered)
  const lines = wrapBitmapText(options.dialogueText || '', FONT_QUILL_8, maxTextWidth).slice(0, 4);
  const stepY = lines.length >= 4 ? 16 : 20;
  let lineY = Math.round(61 - ((lines.length - 1) * stepY) / 2);

  for (const line of lines) {
    drawBitmapText(
      native,
      w,
      h,
      line,
      textCenterX,
      lineY,
      FONT_QUILL_8,
      textColor,
      false
    );
    lineY += stepY;
  }

  // "Click here to continue" prompt (231:5 / 217:5 -> fontId 497 q8_full)
  if (options.showPrompt !== false) {
    const prompt = options.promptText?.trim() || 'Click here to continue';
    drawBitmapText(
      native,
      w,
      h,
      prompt,
      textCenterX,
      102,
      FONT_QUILL_8,
      promptColor,
      false
    );
  }

  const scale = Math.max(1, Math.round(options.scale ?? 1));
  if (scale === 1) {
    return { width: w, height: h, pixels: native };
  }

  return upscaleNearest(native, w, h, scale);
}

export function upscaleNearest(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  scale: number
): RasterOutput {
  const outW = w * scale;
  const outH = h * scale;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < outW; x++) {
      const sx = Math.floor(x / scale);
      const sIdx = (sy * w + sx) * 4;
      const dIdx = (y * outW + x) * 4;
      out[dIdx] = src[sIdx];
      out[dIdx + 1] = src[sIdx + 1];
      out[dIdx + 2] = src[sIdx + 2];
      out[dIdx + 3] = src[sIdx + 3];
    }
  }
  return { width: outW, height: outH, pixels: out };
}

/**
 * Stack multiple dialogue turn chatboxes vertically into a conversation strip.
 */
export function stackChatboxes(frames: RasterOutput[], gap = 4): RasterOutput {
  if (frames.length === 0) {
    return { width: CHATBOX_WIDTH, height: CHATBOX_HEIGHT, pixels: new Uint8ClampedArray(CHATBOX_WIDTH * CHATBOX_HEIGHT * 4) };
  }
  const width = Math.max(...frames.map((f) => f.width));
  const totalHeight = frames.reduce((acc, f) => acc + f.height, 0) + gap * Math.max(0, frames.length - 1);
  const pixels = new Uint8ClampedArray(width * totalHeight * 4);

  let yOff = 0;
  for (const frame of frames) {
    for (let y = 0; y < frame.height; y++) {
      const srcStart = y * frame.width * 4;
      const dstStart = ((yOff + y) * width) * 4;
      pixels.set(frame.pixels.subarray(srcStart, srcStart + frame.width * 4), dstStart);
    }
    yOff += frame.height + gap;
  }

  return { width, height: totalHeight, pixels };
}
