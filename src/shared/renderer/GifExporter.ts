import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { RasterOutput } from './SoftwareRasterizer';

export interface GifFrameInput {
  frame: RasterOutput;
  delayMs: number;
}

/**
 * Encode an array of RGBA frames into an animated GIF buffer.
 * Automatically preserves transparency when transparent=true.
 */
export function encodeAnimatedGif(
  frames: GifFrameInput[],
  transparent = true
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('Cannot encode GIF with 0 frames');
  }

  const width = frames[0].frame.width;
  const height = frames[0].frame.height;
  const gif = GIFEncoder();

  for (let i = 0; i < frames.length; i++) {
    const { frame, delayMs } = frames[i];
    // Clone to Uint8Array backed cleanly for quantize
    const rgba = new Uint8Array(frame.pixels.length);
    rgba.set(frame.pixels);

    let palette: number[][];
    let indexStream: Uint8Array;
    let transparentIndex = -1;

    if (transparent) {
      // Reserve index 0 as explicit transparent color, quantize opaque colors to max 255
      const opaqueColors = quantize(rgba, 255, {
        format: 'rgba4444',
        oneBitAlpha: true,
        clearAlpha: true,
        clearAlphaThreshold: 127,
      });

      // Ensure [0, 0, 0, 0] sits at index 0
      const filtered = opaqueColors.filter((c) => (c[3] ?? 255) > 127);
      palette = [[0, 0, 0, 0], ...filtered.slice(0, 255)];
      transparentIndex = 0;

      // Normalize pixels for palette matching
      const rgbPalette = palette.map(([r, g, b]) => [r, g, b]);
      indexStream = applyPalette(rgba, rgbPalette, 'rgb565');
      for (let p = 0; p < indexStream.length; p++) {
        if (rgba[p * 4 + 3] < 128) {
          indexStream[p] = 0;
        } else if (indexStream[p] === 0 && palette.length > 1) {
          // Avoid mapping opaque black pixels onto transparent index 0
          indexStream[p] = 1;
        }
      }
    } else {
      palette = quantize(rgba, 256, { format: 'rgb565' });
      indexStream = applyPalette(rgba, palette, 'rgb565');
    }

    gif.writeFrame(indexStream, width, height, {
      palette,
      delay: Math.max(20, delayMs),
      transparent: transparent && transparentIndex >= 0,
      transparentIndex: transparent ? transparentIndex : undefined,
      dispose: transparent ? 2 : 1,
      repeat: 0,
    });
  }

  gif.finish();
  return gif.bytes();
}
