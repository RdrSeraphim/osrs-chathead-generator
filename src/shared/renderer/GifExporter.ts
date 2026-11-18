import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { RasterOutput } from './SoftwareRasterizer';

export interface GifFrameInput {
  frame: RasterOutput;
  delayMs: number;
}

/**
 * Encode an array of RGBA frames into an animated GIF buffer using a single shared global palette
 * and cached pose index streams for fast encoding.
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

  // Sample up to 3 evenly spaced unique frames so open-mouth / blink colors are represented in the global palette
  const sampleFrames: RasterOutput[] = [];
  const sampleIndices = [
    0,
    Math.floor(frames.length / 3),
    Math.floor((2 * frames.length) / 3),
  ];
  for (const idx of sampleIndices) {
    const f = frames[idx]?.frame;
    if (f && !sampleFrames.includes(f)) {
      sampleFrames.push(f);
    }
  }
  const totalSampleBytes = sampleFrames.reduce((acc, f) => acc + f.pixels.length, 0);
  const sampleRgba = new Uint8Array(totalSampleBytes);
  let sampleOff = 0;
  for (const sf of sampleFrames) {
    sampleRgba.set(sf.pixels, sampleOff);
    sampleOff += sf.pixels.length;
  }

  let palette: number[][];
  let transparentIndex = -1;
  if (transparent) {
    const opaqueColors = quantize(sampleRgba, 255, {
      format: 'rgba4444',
      oneBitAlpha: true,
      clearAlpha: true,
      clearAlphaThreshold: 127,
    });
    const filtered = opaqueColors.filter((c) => (c[3] ?? 255) > 127);
    palette = [[0, 0, 0, 0], ...filtered.slice(0, 255)];
    transparentIndex = 0;
  } else {
    palette = quantize(sampleRgba, 256, { format: 'rgb565' });
  }

  const rgbPalette = palette.map(([r, g, b]) => [r, g, b]);
  const indexStreamCache = new Map<RasterOutput, Uint8Array>();

  for (let i = 0; i < frames.length; i++) {
    const { frame, delayMs } = frames[i];
    let indexStream = indexStreamCache.get(frame);

    if (!indexStream) {
      const rgba = new Uint8Array(
        frame.pixels.buffer,
        frame.pixels.byteOffset,
        frame.pixels.byteLength
      );
      indexStream = applyPalette(rgba, rgbPalette, 'rgb565');
      if (transparent) {
        for (let p = 0; p < indexStream.length; p++) {
          if (rgba[p * 4 + 3] < 128) {
            indexStream[p] = 0;
          } else if (indexStream[p] === 0 && palette.length > 1) {
            // Avoid mapping opaque black pixels onto transparent index 0
            indexStream[p] = 1;
          }
        }
      }
      indexStreamCache.set(frame, indexStream);
    }

    gif.writeFrame(indexStream, width, height, {
      palette: i === 0 ? palette : undefined,
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
