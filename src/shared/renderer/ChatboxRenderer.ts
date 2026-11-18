import {
  drawBitmapText,
  FONT_QUILL_8,
  wrapBitmapText,
} from '../constants/bitmapFonts';
import {
  AUTHENTIC_CHATBOX_HEIGHT,
  AUTHENTIC_CHATBOX_WIDTH,
  decodeAuthenticChatboxBackdrop,
} from '../constants/chatboxBackdrop';
import { RasterOutput } from './SoftwareRasterizer';

export const CHATBOX_WIDTH = AUTHENTIC_CHATBOX_WIDTH;
export const CHATBOX_HEIGHT = AUTHENTIC_CHATBOX_HEIGHT;

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

let cachedBackdrop: Uint8ClampedArray | null = null;

function getChatboxBackdrop(): Uint8ClampedArray {
  if (!cachedBackdrop) {
    cachedBackdrop = decodeAuthenticChatboxBackdrop();
  }
  return cachedBackdrop;
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

  // Blit chathead into the authentic 96x96 Interface 231/217 slot (clipped to x: 19..114 or 402..497, y: 23..118)
  if (chathead && options.layout !== 'none') {
    const slotX = options.layout === 'npc-left' ? 19 : 402;
    const slotY = 23;
    const nativeBoxSize = 96;
    const slotOriginX = options.layout === 'npc-left' ? 49 : 47;
    const slotOriginY = 53;
    const hasOrigin =
      chathead.originX !== undefined &&
      chathead.originY !== undefined &&
      chathead.scale !== undefined;

    const srcW = chathead.width;
    const srcH = chathead.height;
    for (let dy = 0; dy < nativeBoxSize; dy++) {
      const py = slotY + dy;
      if (py < 7 || py >= h - 7) continue;
      const sy = hasOrigin
        ? Math.floor(chathead.originY! + (dy - slotOriginY + 0.5) * chathead.scale!)
        : Math.min(srcH - 1, Math.floor((dy * srcH) / nativeBoxSize));
      if (sy < 0 || sy >= srcH) continue;
      for (let dx = 0; dx < nativeBoxSize; dx++) {
        const px = slotX + dx;
        if (px < 7 || px >= w - 7) continue;
        const sx = hasOrigin
          ? Math.floor(chathead.originX! + (dx - slotOriginX + 0.5) * chathead.scale!)
          : Math.min(srcW - 1, Math.floor((dx * srcW) / nativeBoxSize));
        if (sx < 0 || sx >= srcW) continue;
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
      23,
      FONT_QUILL_8,
      nameColor,
      false
    );
  }

  // Dialogue Body Lines (231:6 / 217:6 -> fontId 497 q8_full, max 4 lines vertically centered)
  const lines = wrapBitmapText(options.dialogueText || '', FONT_QUILL_8, maxTextWidth).slice(0, 4);
  const stepY = lines.length >= 4 ? 16 : 20;
  let lineY = Math.round(62 - ((lines.length - 1) * stepY) / 2);

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
      103,
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
