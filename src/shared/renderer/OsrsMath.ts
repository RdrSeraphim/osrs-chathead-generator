export const SINE = new Int32Array(2048);
export const COSINE = new Int32Array(2048);

for (let i = 0; i < 2048; i++) {
  const rad = (i * Math.PI) / 1024;
  SINE[i] = Math.floor(65536 * Math.sin(rad));
  COSINE[i] = Math.floor(65536 * Math.cos(rad));
}

export function buildHslPalette(brightness = 0.75): Uint32Array {
  const palette = new Uint32Array(65536);
  for (let hsl = 0; hsl < 65536; hsl++) {
    const hue = ((hsl >> 10) & 63) / 64 + 0.0078125;
    const sat = ((hsl >> 7) & 7) / 8 + 0.0625;
    const lum = (hsl & 127) / 128;

    let r = lum;
    let g = lum;
    let b = lum;

    if (sat !== 0) {
      const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat;
      const p = 2 * lum - q;
      const tR = hue + 1 / 3;
      const tG = hue;
      const tB = hue - 1 / 3;

      const hueToRgb = (t: number): number => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t * 6 < 1) return p + (q - p) * 6 * t;
        if (t * 2 < 1) return q;
        if (t * 3 < 2) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      r = hueToRgb(tR);
      g = hueToRgb(tG);
      b = hueToRgb(tB);
    }

    r = Math.pow(Math.max(0, Math.min(1, r)), brightness);
    g = Math.pow(Math.max(0, Math.min(1, g)), brightness);
    b = Math.pow(Math.max(0, Math.min(1, b)), brightness);

    let ri = Math.min(255, Math.max(0, Math.floor(r * 256)));
    let gi = Math.min(255, Math.max(0, Math.floor(g * 256)));
    let bi = Math.min(255, Math.max(0, Math.floor(b * 256)));

    let rgb = (ri << 16) | (gi << 8) | bi;
    if (rgb === 0) rgb = 1;
    palette[hsl] = rgb;
  }
  return palette;
}

export const DEFAULT_HSL_PALETTE = buildHslPalette(0.75);

export function adjustHslLightness(hsl: number, lightness: number): number {
  let l = ((hsl & 0x7f) * lightness) >> 7;
  if (l < 2) l = 2;
  else if (l > 126) l = 126;
  return (hsl & 0xff80) + l;
}

export function hsl16ToHex(hsl: number, palette: Uint32Array = DEFAULT_HSL_PALETTE): string {
  const rgb = palette[hsl & 0xffff];
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function hexToHsl16(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lum = (max + min) / 2;
  let hue = 0;
  let sat = 0;

  if (max !== min) {
    const d = max - min;
    sat = lum > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue /= 6;
  }

  const h6 = Math.min(63, Math.max(0, Math.round(hue * 63)));
  const s3 = Math.min(7, Math.max(0, Math.round(sat * 7)));
  const l7 = Math.min(127, Math.max(0, Math.round(lum * 127)));
  return (h6 << 10) | (s3 << 7) | l7;
}
