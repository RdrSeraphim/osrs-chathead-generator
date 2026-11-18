import { AnimatedVertices, LitMesh } from './ModelMesh';
import { buildHslPalette, COSINE, DEFAULT_HSL_PALETTE, SINE } from './OsrsMath';

export interface CameraParams {
  modelZoom: number;
  rotationX: number; // pitch (0..2047)
  rotationY: number; // yaw (0..2047) — 1882 for NPC (facing right), 166 for Player (facing left)
  rotationZ: number; // roll (0..2047)
  offsetX: number;
  offsetY: number;
  brightness?: number;
}

export const OSRS_NPC_CHATHEAD_CAMERA: CameraParams = {
  modelZoom: 796,
  rotationX: 40,
  rotationY: 1882, // -166 in 2048-unit circle -> faces right
  rotationZ: 0,
  offsetX: 0,
  offsetY: 0,
};

export const OSRS_PLAYER_CHATHEAD_CAMERA: CameraParams = {
  modelZoom: 796,
  rotationX: 40,
  rotationY: 166, // +166 in 2048-unit circle -> faces left
  rotationZ: 0,
  offsetX: 0,
  offsetY: 0,
};

export interface RasterOutput {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export function renderChathead(
  mesh: LitMesh,
  animated: AnimatedVertices,
  camera: CameraParams,
  baseWidth = 96,
  baseHeight = 96,
  scale = 2
): RasterOutput {
  const width = Math.max(1, Math.round(baseWidth * scale));
  const height = Math.max(1, Math.round(baseHeight * scale));
  const pixels = new Uint8ClampedArray(width * height * 4);

  if (mesh.faceCount === 0 || mesh.vertexCount === 0) {
    return { width, height, pixels };
  }

  const palette =
    camera.brightness !== undefined && camera.brightness !== 0.75
      ? buildHslPalette(camera.brightness)
      : DEFAULT_HSL_PALETTE;

  const pitch = ((Math.round(camera.rotationX) % 2048) + 2048) % 2048;
  const yaw = ((Math.round(camera.rotationY) % 2048) + 2048) % 2048;
  const roll = ((Math.round(camera.rotationZ) % 2048) + 2048) % 2048;
  const zoom = Math.max(64, camera.modelZoom);

  const sinX = SINE[pitch];
  const cosX = COSINE[pitch];
  const sinY = SINE[yaw];
  const cosY = COSINE[yaw];
  const sinZ = SINE[roll];
  const cosZ = COSINE[roll];

  const originOffsetX = ((camera.rotationY > 1024 ? 1 : -1) * baseWidth) / 96;
  const originOffsetY = (5 * baseHeight) / 96;
  const centerX = width / 2 + (originOffsetX + camera.offsetX) * scale;
  const centerY = height / 2 + (originOffsetY + camera.offsetY) * scale;
  const fov = 512 * scale;

  const screenX = new Float64Array(mesh.vertexCount);
  const screenY = new Float64Array(mesh.vertexCount);
  const depthZ = new Float64Array(mesh.vertexCount);

  const vx = animated.verticesX;
  const vy = animated.verticesY;
  const vz = animated.verticesZ;

  for (let i = 0; i < mesh.vertexCount; i++) {
    let x = vx[i];
    let y = vy[i];
    let z = vz[i];

    // 1. Roll around Z
    if (roll !== 0) {
      const nx = (cosZ * x + sinZ * y) >> 16;
      y = (cosZ * y - sinZ * x) >> 16;
      x = nx;
    }

    // 2. Yaw around Y
    if (yaw !== 0) {
      const nx = (sinY * z + cosY * x) >> 16;
      z = (cosY * z - sinY * x) >> 16;
      x = nx;
    }

    // 3. Camera pitch around X + zoom translation
    const yCam = (cosX * y - sinX * z) >> 16;
    const zCam = ((sinX * y + cosX * z) >> 16) + zoom;

    depthZ[i] = zCam;
    if (zCam >= 32) {
      screenX[i] = centerX + (x * fov) / zCam;
      screenY[i] = centerY + (yCam * fov) / zCam;
    } else {
      screenX[i] = centerX + x * fov;
      screenY[i] = centerY + yCam * fov;
    }
  }

  // Collect visible faces with priority & depth for Painter's sort
  interface VisibleFace {
    index: number;
    priority: number;
    avgDepth: number;
  }

  const visibleFaces: VisibleFace[] = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    if (mesh.faceHslC[f] === -2) continue;

    const ia = mesh.faceA[f];
    const ib = mesh.faceB[f];
    const ic = mesh.faceC[f];

    if (depthZ[ia] < 32 || depthZ[ib] < 32 || depthZ[ic] < 32) continue;

    const ax = screenX[ia];
    const ay = screenY[ia];
    const bx = screenX[ib];
    const by = screenY[ib];
    const cx = screenX[ic];
    const cy = screenY[ic];

    // Back-face culling
    if ((ax - bx) * (cy - by) - (ay - by) * (cx - bx) <= 0) {
      continue;
    }

    const pri = mesh.facePriorities ? mesh.facePriorities[f] : mesh.defaultPriority;
    const avgDepth = (depthZ[ia] + depthZ[ib] + depthZ[ic]) / 3;
    visibleFaces.push({ index: f, priority: pri, avgDepth });
  }

  // Sort back-to-front: lower priority first, then greater depth (farther) first
  visibleFaces.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.avgDepth - a.avgDepth;
  });

  const alphas = animated.faceAlphas;

  for (let i = 0; i < visibleFaces.length; i++) {
    const f = visibleFaces[i].index;
    const ia = mesh.faceA[f];
    const ib = mesh.faceB[f];
    const ic = mesh.faceC[f];

    const alphaByte = alphas ? alphas[f] : 0;
    if (alphaByte >= 255) continue;

    const hslA = mesh.faceHslA[f];
    const hslB = mesh.faceHslB[f];
    const hslC = mesh.faceHslC[f];

    if (hslC === -1) {
      // Flat triangle
      const rgb = palette[hslA & 0xffff];
      drawFlatTriangle(
        pixels,
        width,
        height,
        screenX[ia],
        screenY[ia],
        screenX[ib],
        screenY[ib],
        screenX[ic],
        screenY[ic],
        rgb,
        255 - alphaByte
      );
    } else {
      // Gouraud shaded triangle
      drawGouraudTriangle(
        pixels,
        width,
        height,
        screenX[ia],
        screenY[ia],
        screenX[ib],
        screenY[ib],
        screenX[ic],
        screenY[ic],
        hslA,
        hslB,
        hslC,
        palette,
        255 - alphaByte
      );
    }
  }

  return { width, height, pixels };
}

function drawFlatTriangle(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rgb: number,
  opacity: number
): void {
  let ax = x0, ay = y0;
  let bx = x1, by = y1;
  let cx = x2, cy = y2;

  if (ay > by) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
  if (ay > cy) { [ax, cx] = [cx, ax]; [ay, cy] = [cy, ay]; }
  if (by > cy) { [bx, cx] = [cx, bx]; [by, cy] = [cy, by]; }

  const minY = Math.max(0, Math.ceil(ay - 0.5));
  const maxY = Math.min(height - 1, Math.floor(cy - 0.5));
  if (maxY < minY) return;

  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;

  const dyAC = cy - ay || 1e-6;
  const dyAB = by - ay || 1e-6;
  const dyBC = cy - by || 1e-6;

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    const xa = ax + ((cx - ax) * (py - ay)) / dyAC;
    const xb =
      py < by
        ? ax + ((bx - ax) * (py - ay)) / dyAB
        : bx + ((cx - bx) * (py - by)) / dyBC;

    const left = xa < xb ? xa : xb;
    const right = xa < xb ? xb : xa;

    const xStart = Math.max(0, Math.ceil(left - 0.5));
    const xEnd = Math.min(width - 1, Math.floor(right - 0.5));

    for (let x = xStart; x <= xEnd; x++) {
      plotPixel(pixels, (y * width + x) * 4, r, g, b, opacity);
    }
  }
}

function drawGouraudTriangle(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  c0: number,
  c1: number,
  c2: number,
  palette: Uint32Array,
  opacity: number
): void {
  let ax = x0, ay = y0, ca = c0;
  let bx = x1, by = y1, cb = c1;
  let cx = x2, cy = y2, cc = c2;

  if (ay > by) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; [ca, cb] = [cb, ca]; }
  if (ay > cy) { [ax, cx] = [cx, ax]; [ay, cy] = [cy, ay]; [ca, cc] = [cc, ca]; }
  if (by > cy) { [bx, cx] = [cx, bx]; [by, cy] = [cy, by]; [cb, cc] = [cc, cb]; }

  const minY = Math.max(0, Math.ceil(ay - 0.5));
  const maxY = Math.min(height - 1, Math.floor(cy - 0.5));
  if (maxY < minY) return;

  const dyAC = cy - ay || 1e-6;
  const dyAB = by - ay || 1e-6;
  const dyBC = cy - by || 1e-6;

  // Base hue/saturation bits stay constant; interpolate 7-bit lightness cleanly
  const baseHS = ca & 0xff80;
  const la = ca & 0x7f;
  const lb = cb & 0x7f;
  const lc = cc & 0x7f;

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    const tAC = Math.max(0, Math.min(1, (py - ay) / dyAC));
    const xa = ax + (cx - ax) * tAC;
    const lA = la + (lc - la) * tAC;

    let xb: number;
    let lB: number;
    if (py < by) {
      const tAB = Math.max(0, Math.min(1, (py - ay) / dyAB));
      xb = ax + (bx - ax) * tAB;
      lB = la + (lb - la) * tAB;
    } else {
      const tBC = Math.max(0, Math.min(1, (py - by) / dyBC));
      xb = bx + (cx - bx) * tBC;
      lB = lb + (lc - lb) * tBC;
    }

    const leftX = xa < xb ? xa : xb;
    const rightX = xa < xb ? xb : xa;
    const leftL = xa < xb ? lA : lB;
    const rightL = xa < xb ? lB : lA;

    const span = rightX - leftX;
    const xStart = Math.max(0, Math.ceil(leftX - 0.5));
    const xEnd = Math.min(width - 1, Math.floor(rightX - 0.5));

    for (let x = xStart; x <= xEnd; x++) {
      const tx = span > 1e-4 ? Math.max(0, Math.min(1, (x + 0.5 - leftX) / span)) : 0;
      const lum = Math.max(2, Math.min(126, Math.round(leftL + (rightL - leftL) * tx)));
      const rgb = palette[(baseHS | lum) & 0xffff];
      plotPixel(
        pixels,
        (y * width + x) * 4,
        (rgb >> 16) & 0xff,
        (rgb >> 8) & 0xff,
        rgb & 0xff,
        opacity
      );
    }
  }
}

function plotPixel(
  pixels: Uint8ClampedArray,
  idx: number,
  r: number,
  g: number,
  b: number,
  opacity: number
): void {
  if (opacity >= 255 || pixels[idx + 3] === 0) {
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
    pixels[idx + 3] = opacity;
    return;
  }

  const a = opacity / 255;
  const inv = 1 - a;
  pixels[idx] = Math.round(r * a + pixels[idx] * inv);
  pixels[idx + 1] = Math.round(g * a + pixels[idx + 1] * inv);
  pixels[idx + 2] = Math.round(b * a + pixels[idx + 2] * inv);
  pixels[idx + 3] = Math.min(255, Math.round(opacity + pixels[idx + 3] * inv));
}

/**
 * Compute bounding box and centroid of a mesh for auto-fit fallback when an NPC has no dedicated chatheadModels.
 */
export function computeAutoFitCamera(
  mesh: LitMesh,
  facingRight: boolean
): CameraParams {
  if (mesh.vertexCount === 0) {
    return facingRight ? OSRS_NPC_CHATHEAD_CAMERA : OSRS_PLAYER_CHATHEAD_CAMERA;
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.verticesX[i];
    const y = mesh.verticesY[i];
    const z = mesh.verticesZ[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 64);
  const centerY = (minY + maxY) / 2;
  const zoom = Math.round((span * 512) / 56);

  return {
    modelZoom: Math.max(300, Math.min(4000, zoom)),
    rotationX: 40,
    rotationY: facingRight ? 1882 : 166,
    rotationZ: 0,
    offsetX: 0,
    offsetY: Math.round((-centerY * 512) / Math.max(1, zoom)),
  };
}
