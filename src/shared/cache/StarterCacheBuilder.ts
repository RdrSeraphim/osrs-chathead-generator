import { packJs5, packMultiFileArchive } from './decompression';
import { hexToHsl16 } from '../renderer/OsrsMath';
import { DEFAULT_HAIR_SOURCE_HSL, DEFAULT_SKIN_SOURCE_HSL } from '../constants/playerColors';

interface RawMeshBuilder {
  vx: number[];
  vy: number[];
  vz: number[];
  vSkins: number[];
  fa: number[];
  fb: number[];
  fc: number[];
  fColors: number[];
  fPriorities: number[];
}

function createBuilder(): RawMeshBuilder {
  return {
    vx: [],
    vy: [],
    vz: [],
    vSkins: [],
    fa: [],
    fb: [],
    fc: [],
    fColors: [],
    fPriorities: [],
  };
}

function addBox(
  m: RawMeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
  hsl: number,
  skinGroup = 0,
  priority = 0,
  taperTop = 1
): void {
  const base = m.vx.length;
  const tx = Math.round(rx * taperTop);
  const tz = Math.round(rz * taperTop);
  // 8 corners: 0..3 top (-Y), 4..7 bottom (+Y)
  const pts: Array<[number, number, number]> = [
    [cx - tx, cy - ry, cz - tz], // 0: top-left-front
    [cx + tx, cy - ry, cz - tz], // 1: top-right-front
    [cx + tx, cy - ry, cz + tz], // 2: top-right-back
    [cx - tx, cy - ry, cz + tz], // 3: top-left-back
    [cx - rx, cy + ry, cz - rz], // 4: bot-left-front
    [cx + rx, cy + ry, cz - rz], // 5: bot-right-front
    [cx + rx, cy + ry, cz + rz], // 6: bot-right-back
    [cx - rx, cy + ry, cz + rz], // 7: bot-left-back
  ];
  for (const [x, y, z] of pts) {
    m.vx.push(Math.round(x));
    m.vy.push(Math.round(y));
    m.vz.push(Math.round(z));
    m.vSkins.push(skinGroup);
  }

  const quads: Array<[number, number, number, number]> = [
    [0, 4, 5, 1], // front (-Z)
    [1, 5, 6, 2], // right (+X)
    [2, 6, 7, 3], // back (+Z)
    [3, 7, 4, 0], // left (-X)
    [3, 0, 1, 2], // top (-Y)
    [4, 7, 6, 5], // bottom (+Y)
  ];

  for (const [q0, q1, q2, q3] of quads) {
    pushOrientedTri(m, base + q0, base + q1, base + q2, cx, cy, cz, hsl, priority);
    pushOrientedTri(m, base + q0, base + q2, base + q3, cx, cy, cz, hsl, priority);
  }
}

function addPrismOctagonHead(
  m: RawMeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
  hsl: number,
  skinGroup = 0,
  priority = 0,
  chinScale = 0.84,
  crownScale = 0.92
): void {
  const base = m.vx.length;
  const rings = [
    { y: cy - ry, s: crownScale * 0.72 },
    { y: cy - ry * 0.45, s: 1.0 },
    { y: cy + ry * 0.25, s: 0.96 },
    { y: cy + ry, s: chinScale },
  ];

  const segs = 8;
  for (const ring of rings) {
    for (let i = 0; i < segs; i++) {
      // Angle starting at -Z front-left so facets look cleanly modeled
      const a = (i / segs) * Math.PI * 2 + Math.PI / 8;
      const x = cx + Math.sin(a) * rx * ring.s;
      const z = cz - Math.cos(a) * rz * ring.s;
      m.vx.push(Math.round(x));
      m.vy.push(Math.round(ring.y));
      m.vz.push(Math.round(z));
      m.vSkins.push(skinGroup);
    }
  }

  // Top & bottom center caps
  const topCenter = m.vx.length;
  m.vx.push(Math.round(cx));
  m.vy.push(Math.round(cy - ry * 1.08));
  m.vz.push(Math.round(cz));
  m.vSkins.push(skinGroup);

  const botCenter = m.vx.length;
  m.vx.push(Math.round(cx));
  m.vy.push(Math.round(cy + ry * 1.04));
  m.vz.push(Math.round(cz));
  m.vSkins.push(skinGroup);

  // Side quads
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < segs; i++) {
      const next = (i + 1) % segs;
      const a = base + r * segs + i;
      const b = base + (r + 1) * segs + i;
      const c = base + (r + 1) * segs + next;
      const d = base + r * segs + next;
      pushOrientedTri(m, a, b, c, cx, cy, cz, hsl, priority);
      pushOrientedTri(m, a, c, d, cx, cy, cz, hsl, priority);
    }
  }

  // Caps
  for (let i = 0; i < segs; i++) {
    const next = (i + 1) % segs;
    pushOrientedTri(m, topCenter, base + i, base + next, cx, cy, cz, hsl, priority);
    const botStart = base + (rings.length - 1) * segs;
    pushOrientedTri(m, botCenter, botStart + next, botStart + i, cx, cy, cz, hsl, priority);
  }
}

function pushOrientedTri(
  m: RawMeshBuilder,
  ia: number,
  ib: number,
  ic: number,
  refX: number,
  refY: number,
  refZ: number,
  hsl: number,
  priority: number
): void {
  const ax = m.vx[ia], ay = m.vy[ia], az = m.vz[ia];
  const bx = m.vx[ib], by = m.vy[ib], bz = m.vz[ib];
  const cx = m.vx[ic], cy = m.vy[ic], cz = m.vz[ic];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  // Cross AB x AC
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;

  // Outward vector from ref center
  const mx = (ax + bx + cx) / 3 - refX;
  const my = (ay + by + cy) / 3 - refY;
  const mz = (az + bz + cz) / 3 - refZ;

  // For OSRS left-handed space (-Z front, +Y down, +X right):
  // Outward front face (-Z) has AB x AC pointing along -Z (same sign as mz < 0).
  const dot = nx * mx + ny * my + nz * mz;
  if (dot >= 0) {
    m.fa.push(ia);
    m.fb.push(ib);
    m.fc.push(ic);
  } else {
    m.fa.push(ia);
    m.fb.push(ic);
    m.fc.push(ib);
  }
  m.fColors.push(hsl & 0xffff);
  m.fPriorities.push(priority);
}

function addHumanFaceFeatures(
  m: RawMeshBuilder,
  eyeHsl: number,
  browHsl: number,
  mouthHsl: number,
  skinHsl: number
): void {
  // Nose
  addBox(m, 0, -24, -36, 5, 10, 7, skinHsl, 0, 2, 0.65);
  // Eyes
  addBox(m, -14, -36, -33, 6, 4, 3, 127, 2, 3); // left eye white
  addBox(m, 14, -36, -33, 6, 4, 3, 127, 2, 3);  // right eye white
  addBox(m, -13, -36, -35, 3, 3, 2, eyeHsl, 2, 4); // left pupil
  addBox(m, 13, -36, -35, 3, 3, 2, eyeHsl, 2, 4);  // right pupil
  // Eyebrows (skin group 2 so happy/angry animations raise/furrow brows)
  addBox(m, -14, -44, -34, 8, 2, 3, browHsl, 2, 4);
  addBox(m, 14, -44, -34, 8, 2, 3, browHsl, 2, 4);
  // Mouth (skin group 1 = jaw!)
  addBox(m, 0, -4, -34, 12, 3, 3, mouthHsl, 1, 3);
  // Chin / Jawbone (skin group 1)
  addBox(m, 0, 6, -12, 22, 10, 22, skinHsl, 1, 1, 1.05);
}

function encodeModelV2(m: RawMeshBuilder): Uint8Array {
  const vCount = m.vx.length;
  const fCount = m.fa.length;

  const encodeSmart = (buf: number[], val: number) => {
    if (val >= -64 && val <= 63) {
      buf.push((val + 64) & 0xff);
    } else {
      const enc = val + 49152;
      buf.push((enc >> 8) & 0xff, enc & 0xff);
    }
  };

  const vFlags: number[] = [];
  const xBytes: number[] = [];
  const yBytes: number[] = [];
  const zBytes: number[] = [];
  let px = 0, py = 0, pz = 0;

  for (let i = 0; i < vCount; i++) {
    const dx = m.vx[i] - px;
    const dy = m.vy[i] - py;
    const dz = m.vz[i] - pz;
    px = m.vx[i];
    py = m.vy[i];
    pz = m.vz[i];
    let flag = 0;
    if (dx !== 0) { flag |= 1; encodeSmart(xBytes, dx); }
    if (dy !== 0) { flag |= 2; encodeSmart(yBytes, dy); }
    if (dz !== 0) { flag |= 4; encodeSmart(zBytes, dz); }
    vFlags.push(flag);
  }

  const fCompress = new Array<number>(fCount).fill(1);
  const fIdxBytes: number[] = [];
  let last = 0;
  for (let i = 0; i < fCount; i++) {
    const a = m.fa[i], b = m.fb[i], c = m.fc[i];
    encodeSmart(fIdxBytes, a - last);
    encodeSmart(fIdxBytes, b - a);
    encodeSmart(fIdxBytes, c - b);
    last = c;
  }

  const faceColorsBytes: number[] = [];
  for (let i = 0; i < fCount; i++) {
    const col = m.fColors[i] & 0xffff;
    faceColorsBytes.push((col >> 8) & 0xff, col & 0xff);
  }

  const prioritiesBytes = m.fPriorities.map((p) => p & 0xff);
  const vSkinsBytes = m.vSkins.map((s) => s & 0xff);

  const bodyParts = [
    ...vFlags,
    ...fCompress,
    ...prioritiesBytes,
    ...vSkinsBytes,
    ...fIdxBytes,
    ...faceColorsBytes,
    ...xBytes,
    ...yBytes,
    ...zBytes,
    0, // hasOffsets = 0
  ];

  // 23-byte v2 footer ending in -1, -2
  const footer = new Uint8Array(23);
  const fv = new DataView(footer.buffer);
  fv.setUint16(0, vCount, false);
  fv.setUint16(2, fCount, false);
  fv.setUint8(4, 0); // numTexFaces
  fv.setUint8(5, 0); // hasFaceTypes
  fv.setUint8(6, 255); // priorityFlag = per-face
  fv.setUint8(7, 0); // hasAlphas
  fv.setUint8(8, 0); // hasFaceSkins
  fv.setUint8(9, 1); // hasVertexSkins
  fv.setUint8(10, 0); // hasAnimaya
  fv.setUint16(11, xBytes.length, false);
  fv.setUint16(13, yBytes.length, false);
  fv.setUint16(15, zBytes.length, false);
  fv.setUint16(17, fIdxBytes.length, false);
  fv.setUint16(19, vSkinsBytes.length, false);
  fv.setInt8(21, -1);
  fv.setInt8(22, -2);

  const out = new Uint8Array(bodyParts.length + 23);
  out.set(bodyParts, 0);
  out.set(footer, bodyParts.length);
  return out;
}

function encodeNpc(opts: {
  name: string;
  models: number[];
  chatheadModels: number[];
  recolorFrom?: number[];
  recolorTo?: number[];
  combatLevel?: number;
  standingAnimation?: number;
  multiChildren?: number[];
}): Uint8Array {
  const b: number[] = [];
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
    b.push(0);
  };
  const writeU16 = (v: number) => b.push((v >> 8) & 0xff, v & 0xff);

  if (opts.models.length > 0) {
    b.push(1, opts.models.length);
    for (const m of opts.models) writeU16(m);
  }
  b.push(2);
  writeStr(opts.name);
  if (opts.standingAnimation !== undefined && opts.standingAnimation >= 0) {
    b.push(13);
    writeU16(opts.standingAnimation);
  }
  if (opts.recolorFrom && opts.recolorTo && opts.recolorFrom.length > 0) {
    b.push(40, opts.recolorFrom.length);
    for (let i = 0; i < opts.recolorFrom.length; i++) {
      writeU16(opts.recolorFrom[i]);
      writeU16(opts.recolorTo[i]);
    }
  }
  if (opts.chatheadModels.length > 0) {
    b.push(60, opts.chatheadModels.length);
    for (const m of opts.chatheadModels) writeU16(m);
  }
  if (opts.combatLevel !== undefined && opts.combatLevel >= 0) {
    b.push(95);
    writeU16(opts.combatLevel);
  }
  if (opts.multiChildren && opts.multiChildren.length > 0) {
    b.push(106);
    writeU16(1); // varbit
    writeU16(0xffff); // varp
    b.push(opts.multiChildren.length - 1);
    for (const c of opts.multiChildren) writeU16(c);
  }
  b.push(0);
  return new Uint8Array(b);
}

function encodeItem(opts: {
  name: string;
  inventoryModel: number;
  wearpos1?: number;
  wearpos2?: number;
  wearpos3?: number;
  maleHeadModel?: number;
  femaleHeadModel?: number;
  maleHeadModel2?: number;
  femaleHeadModel2?: number;
  recolorFrom?: number[];
  recolorTo?: number[];
}): Uint8Array {
  const b: number[] = [];
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
    b.push(0);
  };
  const writeU16 = (v: number) => b.push((v >> 8) & 0xff, v & 0xff);

  b.push(1);
  writeU16(opts.inventoryModel);
  b.push(2);
  writeStr(opts.name);
  if (opts.wearpos1 !== undefined) b.push(13, opts.wearpos1);
  if (opts.wearpos2 !== undefined) b.push(14, opts.wearpos2);
  if (opts.wearpos3 !== undefined) b.push(27, opts.wearpos3);
  if (opts.recolorFrom && opts.recolorTo && opts.recolorFrom.length > 0) {
    b.push(40, opts.recolorFrom.length);
    for (let i = 0; i < opts.recolorFrom.length; i++) {
      writeU16(opts.recolorFrom[i]);
      writeU16(opts.recolorTo[i]);
    }
  }
  if (opts.maleHeadModel !== undefined) { b.push(90); writeU16(opts.maleHeadModel); }
  if (opts.femaleHeadModel !== undefined) { b.push(91); writeU16(opts.femaleHeadModel); }
  if (opts.maleHeadModel2 !== undefined) { b.push(92); writeU16(opts.maleHeadModel2); }
  if (opts.femaleHeadModel2 !== undefined) { b.push(93); writeU16(opts.femaleHeadModel2); }
  b.push(0);
  return new Uint8Array(b);
}

function encodeKit(opts: {
  bodyPartId: number;
  models: number[];
  chatheadModels: number[];
}): Uint8Array {
  const b: number[] = [];
  const writeU16 = (v: number) => b.push((v >> 8) & 0xff, v & 0xff);
  b.push(1, opts.bodyPartId);
  b.push(2, opts.models.length);
  for (const m of opts.models) writeU16(m);
  for (let i = 0; i < opts.chatheadModels.length; i++) {
    b.push(60 + i);
    writeU16(opts.chatheadModels[i]);
  }
  b.push(0);
  return new Uint8Array(b);
}

function encodeSeq(opts: {
  name: string;
  frameLengths: number[];
  frameIds: number[];
  chatFrameIds?: number[];
}): Uint8Array {
  const b: number[] = [];
  const writeU16 = (v: number) => b.push((v >> 8) & 0xff, v & 0xff);

  b.push(1);
  writeU16(opts.frameIds.length);
  for (const len of opts.frameLengths) writeU16(len);
  for (const fid of opts.frameIds) writeU16(fid & 0xffff);
  for (const fid of opts.frameIds) writeU16((fid >>> 16) & 0xffff);

  if (opts.chatFrameIds && opts.chatFrameIds.length > 0) {
    b.push(12, opts.chatFrameIds.length);
    for (const cfid of opts.chatFrameIds) writeU16(cfid & 0xffff);
    for (const cfid of opts.chatFrameIds) writeU16((cfid >>> 16) & 0xffff);
  }

  b.push(18);
  for (let i = 0; i < opts.name.length; i++) b.push(opts.name.charCodeAt(i));
  b.push(0);
  b.push(0);
  return new Uint8Array(b);
}

function encodeFramemap(types: number[], maps: number[][]): Uint8Array {
  const b: number[] = [types.length, ...types];
  for (const m of maps) b.push(m.length);
  for (const m of maps) for (const g of m) b.push(g);
  return new Uint8Array(b);
}

function encodeFrame(
  framemapId: number,
  ops: Array<{ idx: number; flags: number; dx: number; dy: number; dz: number }>,
  boneCount: number
): Uint8Array {
  const b: number[] = [(framemapId >> 8) & 0xff, framemapId & 0xff, boneCount];
  const flagsArr = new Array<number>(boneCount).fill(0);
  for (const op of ops) flagsArr[op.idx] = op.flags;
  b.push(...flagsArr);

  const pushSmart = (val: number) => {
    if (val >= -64 && val <= 63) {
      b.push((val + 64) & 0xff);
    } else {
      const enc = val + 49152;
      b.push((enc >> 8) & 0xff, enc & 0xff);
    }
  };

  for (let i = 0; i < boneCount; i++) {
    const op = ops.find((o) => o.idx === i);
    if (!op) continue;
    if ((op.flags & 1) !== 0) pushSmart(op.dx);
    if ((op.flags & 2) !== 0) pushSmart(op.dy);
    if ((op.flags & 4) !== 0) pushSmart(op.dz);
  }

  return new Uint8Array(b);
}

function encodeReferenceTable(
  revision: number,
  archives: Array<{ id: number; files: number[] }>
): Uint8Array {
  const sorted = [...archives].sort((a, b) => a.id - b.id);
  const b: number[] = [];
  const pushU16 = (v: number) => b.push((v >> 8) & 0xff, v & 0xff);
  const pushI32 = (v: number) =>
    b.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);

  b.push(6); // protocol 6
  pushI32(revision);
  b.push(0); // flags = 0 (unnamed, unsized)
  pushU16(sorted.length);

  let prevId = 0;
  for (const ar of sorted) {
    pushU16(ar.id - prevId);
    prevId = ar.id;
  }
  for (const _ar of sorted) pushI32(0); // crc
  for (const _ar of sorted) pushI32(revision); // rev
  for (const ar of sorted) pushU16(ar.files.length);

  for (const ar of sorted) {
    const sFiles = [...ar.files].sort((a, b) => a - b);
    let prevF = 0;
    for (const f of sFiles) {
      pushU16(f - prevF);
      prevF = f;
    }
  }

  return new Uint8Array(b);
}

export interface BuiltStarterCache {
  dat2Files: Map<string, Uint8Array>;
  flatFiles: Map<string, Uint8Array>;
  rawDatFiles: Map<string, Uint8Array>;
}

/**
 * Generates an authentic binary OSRS starter cache in three formats (.dat2/.idx*, .flatcache, and plain .dat)
 * containing iconic NPCs, Player Identity Kits, Headgear Items, and multi-frame Animations (frameIds + chatFrameIds).
 */
export function buildStarterCache(): BuiltStarterCache {
  const skin = DEFAULT_SKIN_SOURCE_HSL; // 4550
  const hair = DEFAULT_HAIR_SOURCE_HSL; // 6798
  const darkEye = 16;
  const mouth = hexToHsl16('#7c3830');

  const models = new Map<number, Uint8Array>();

  // --- Model 100: Player Male Head Base + Short Hair ---
  {
    const m = createBuilder();
    addPrismOctagonHead(m, 0, -24, 0, 34, 38, 34, skin, 0, 0);
    addHumanFaceFeatures(m, darkEye, hair, mouth, skin);
    // Hair cap & sideburns (skin group 0, color = hair)
    addBox(m, 0, -56, 4, 36, 12, 36, hair, 0, 2, 0.9);
    addBox(m, 0, -40, 28, 34, 24, 10, hair, 0, 1);
    addBox(m, -33, -38, 4, 4, 16, 24, hair, 0, 1);
    addBox(m, 33, -38, 4, 4, 16, 24, hair, 0, 1);
    // Neck collar
    addBox(m, 0, 22, 4, 20, 14, 18, 8741, 0, 0);
    models.set(100, encodeModelV2(m));
  }

  // --- Model 101: Spiky Hair Head ---
  {
    const m = createBuilder();
    addPrismOctagonHead(m, 0, -24, 0, 34, 38, 34, skin, 0, 0);
    addHumanFaceFeatures(m, darkEye, hair, mouth, skin);
    addBox(m, 0, -58, 2, 35, 11, 35, hair, 0, 2, 0.85);
    addBox(m, -16, -70, -10, 7, 14, 7, hair, 0, 3, 0.25);
    addBox(m, 0, -74, -14, 8, 16, 8, hair, 0, 3, 0.2);
    addBox(m, 16, -70, -10, 7, 14, 7, hair, 0, 3, 0.25);
    addBox(m, 0, 22, 4, 20, 14, 18, 8741, 0, 0);
    models.set(101, encodeModelV2(m));
  }

  // --- Model 102: Bald Head ---
  {
    const m = createBuilder();
    addPrismOctagonHead(m, 0, -24, 0, 34, 38, 34, skin, 0, 0);
    addHumanFaceFeatures(m, darkEye, hair, mouth, skin);
    addBox(m, 0, 22, 4, 20, 14, 18, 8741, 0, 0);
    models.set(102, encodeModelV2(m));
  }

  // --- Model 103: Female Head + Bob Hair ---
  {
    const m = createBuilder();
    addPrismOctagonHead(m, 0, -24, 0, 32, 37, 32, skin, 0, 0, 0.78);
    addHumanFaceFeatures(m, darkEye, hair, hexToHsl16('#a33840'), skin);
    addBox(m, 0, -54, 4, 35, 12, 35, hair, 0, 2, 0.9);
    addBox(m, -33, -24, 8, 5, 32, 24, hair, 0, 2);
    addBox(m, 33, -24, 8, 5, 32, 24, hair, 0, 2);
    addBox(m, 0, -24, 30, 34, 32, 8, hair, 0, 1);
    addBox(m, 0, 22, 4, 18, 14, 16, 8741, 0, 0);
    models.set(103, encodeModelV2(m));
  }

  // --- Model 104: Female Long Ponytail Hair ---
  {
    const m = createBuilder();
    addPrismOctagonHead(m, 0, -24, 0, 32, 37, 32, skin, 0, 0, 0.78);
    addHumanFaceFeatures(m, darkEye, hair, hexToHsl16('#a33840'), skin);
    addBox(m, 0, -54, 4, 35, 11, 35, hair, 0, 2, 0.92);
    addBox(m, 0, -20, 38, 12, 38, 10, hair, 0, 2, 0.7);
    addBox(m, 0, 22, 4, 18, 14, 16, 8741, 0, 0);
    models.set(104, encodeModelV2(m));
  }

  // --- Model 110: Clean Shaven Jaw (empty subtle chin accent) ---
  {
    const m = createBuilder();
    addBox(m, 0, 8, -28, 10, 4, 4, skin, 1, 1);
    models.set(110, encodeModelV2(m));
  }

  // --- Model 111: Full Beard Jaw ---
  {
    const m = createBuilder();
    addBox(m, 0, 4, -22, 28, 16, 18, hair, 1, 2, 0.9);
    addBox(m, 0, -10, -35, 16, 4, 4, hair, 1, 4); // mustache
    addBox(m, 0, 20, -20, 18, 12, 12, hair, 1, 2, 0.65);
    models.set(111, encodeModelV2(m));
  }

  // --- Model 112: Goatee Jaw ---
  {
    const m = createBuilder();
    addBox(m, 0, 10, -26, 12, 12, 10, hair, 1, 3, 0.7);
    addBox(m, 0, -9, -35, 14, 3, 3, hair, 1, 4);
    models.set(112, encodeModelV2(m));
  }

  // --- Model 200: Partyhat Headgear (white base color 127 for recoloring!) ---
  {
    const m = createBuilder();
    const hatBase = 127;
    addBox(m, 0, -64, 0, 36, 6, 36, hatBase, 0, 4);
    for (let i = -2; i <= 2; i++) {
      addBox(m, i * 13, -76, -34, 5, 10, 3, hatBase, 0, 5, 0.2);
      addBox(m, i * 13, -76, 34, 5, 10, 3, hatBase, 0, 5, 0.2);
    }
    addBox(m, -34, -76, -15, 3, 10, 5, hatBase, 0, 5, 0.2);
    addBox(m, 34, -76, -15, 3, 10, 5, hatBase, 0, 5, 0.2);
    addBox(m, -34, -76, 15, 3, 10, 5, hatBase, 0, 5, 0.2);
    addBox(m, 34, -76, 15, 3, 10, 5, hatBase, 0, 5, 0.2);
    models.set(200, encodeModelV2(m));
  }

  // --- Model 201: Full Helm (steel/iron base, hides head/jaw) ---
  {
    const m = createBuilder();
    const steel = hexToHsl16('#7c8288');
    const slit = 16;
    const plume = hexToHsl16('#9e2424');
    addPrismOctagonHead(m, 0, -22, 0, 38, 42, 38, steel, 0, 3, 0.9, 0.92);
    addBox(m, 0, -28, -37, 26, 6, 4, slit, 0, 4); // visor slit
    addBox(m, 0, -14, -37, 5, 16, 4, steel, 0, 5); // nose guard
    addBox(m, 0, -72, 6, 6, 12, 26, plume, 0, 4, 0.7); // top plume
    addBox(m, 0, 22, 4, 22, 12, 20, steel, 0, 0);
    models.set(201, encodeModelV2(m));
  }

  // --- Model 202: Dragon Med Helm ---
  {
    const m = createBuilder();
    const dragonRed = hexToHsl16('#9c1919');
    const gold = hexToHsl16('#d8a828');
    addBox(m, 0, -50, 4, 38, 18, 38, dragonRed, 0, 4, 0.9);
    addBox(m, -36, -34, -4, 6, 22, 30, dragonRed, 0, 4);
    addBox(m, 36, -34, -4, 6, 22, 30, dragonRed, 0, 4);
    addBox(m, -30, -72, -6, 6, 18, 6, gold, 0, 5, 0.3);
    addBox(m, 30, -72, -6, 6, 18, 6, gold, 0, 5, 0.3);
    addBox(m, 0, -40, -37, 6, 10, 4, gold, 0, 5);
    models.set(202, encodeModelV2(m));
  }

  // --- Model 203: Slayer Helmet ---
  {
    const m = createBuilder();
    const darkGrey = hexToHsl16('#3c3c40');
    const bone = hexToHsl16('#c8bfaa');
    const redGlow = hexToHsl16('#bd2020');
    addPrismOctagonHead(m, 0, -24, 0, 38, 42, 38, darkGrey, 0, 3);
    addBox(m, -14, -34, -36, 8, 4, 4, redGlow, 2, 5);
    addBox(m, 14, -34, -36, 8, 4, 4, redGlow, 2, 5);
    addBox(m, 0, -2, -37, 24, 14, 6, bone, 1, 4); // skull/mask plate
    addBox(m, -36, -42, 4, 6, 14, 18, bone, 0, 4);
    addBox(m, 36, -42, 4, 6, 14, 18, bone, 0, 4);
    models.set(203, encodeModelV2(m));
  }

  // --- Model 204: Wizard / Gnome Hat (pointed cone) ---
  {
    const m = createBuilder();
    const hatCol = hexToHsl16('#28469e');
    addBox(m, 0, -56, 0, 46, 4, 46, hatCol, 0, 4); // brim
    addBox(m, 0, -74, 2, 26, 16, 26, hatCol, 0, 5, 0.55);
    addBox(m, 0, -96, 8, 12, 14, 12, hatCol, 0, 5, 0.15);
    models.set(204, encodeModelV2(m));
  }

  // --- Model 205: Santa Hat ---
  {
    const m = createBuilder();
    const red = hexToHsl16('#ba1818');
    const white = 127;
    addBox(m, 0, -56, 0, 38, 7, 38, white, 0, 4);
    addBox(m, 4, -74, 4, 26, 14, 26, red, 0, 5, 0.55);
    addBox(m, 18, -82, 10, 9, 9, 9, white, 0, 6);
    models.set(205, encodeModelV2(m));
  }

  // --- Model 300: Gnome Child Chathead ---
  {
    const m = createBuilder();
    const gSkin = hexToHsl16('#e0b394');
    const gHat = hexToHsl16('#3c8a45');
    addPrismOctagonHead(m, 0, -20, 0, 30, 32, 30, gSkin, 0, 0);
    // Pointy ears
    addBox(m, -38, -24, 2, 12, 5, 5, gSkin, 0, 2, 0.3);
    addBox(m, 38, -24, 2, 12, 5, 5, gSkin, 0, 2, 0.3);
    addHumanFaceFeatures(m, hexToHsl16('#28446b'), hexToHsl16('#664a30'), mouth, gSkin);
    // Iconic green gnome hat
    addBox(m, 0, -52, 0, 38, 5, 38, gHat, 0, 4);
    addBox(m, 0, -72, 2, 24, 16, 24, gHat, 0, 5, 0.45);
    addBox(m, 0, -90, 6, 8, 12, 8, gHat, 0, 5, 0.15);
    models.set(300, encodeModelV2(m));
  }

  // --- Model 301: TzTok-Jad Chathead ---
  {
    const m = createBuilder();
    const obsidian = hexToHsl16('#442622');
    const lava = hexToHsl16('#ef6c18');
    const goldEye = hexToHsl16('#ffbe28');
    addPrismOctagonHead(m, 0, -22, 0, 44, 40, 44, obsidian, 0, 0, 1.05, 0.85);
    // Lava ridges & horns
    addBox(m, -28, -68, -6, 9, 18, 9, lava, 0, 4, 0.2);
    addBox(m, 28, -68, -6, 9, 18, 9, lava, 0, 4, 0.2);
    addBox(m, 0, -64, 4, 8, 16, 14, lava, 0, 4, 0.3);
    // Glowing eyes
    addBox(m, -18, -32, -41, 8, 5, 4, goldEye, 2, 5);
    addBox(m, 18, -32, -41, 8, 5, 4, goldEye, 2, 5);
    // Volcanic jaw & fangs
    addBox(m, 0, 10, -14, 34, 16, 30, obsidian, 1, 2);
    addBox(m, -18, -2, -40, 5, 10, 5, lava, 1, 5, 0.3);
    addBox(m, 18, -2, -40, 5, 10, 5, lava, 1, 5, 0.3);
    models.set(301, encodeModelV2(m));
  }

  // --- Model 302: Zulrah Chathead (base serpentine teal 33463) ---
  {
    const m = createBuilder();
    const scales = 33463;
    const belly = hexToHsl16('#c4b472');
    const fang = 127;
    const eye = hexToHsl16('#ffe844');
    addPrismOctagonHead(m, 0, -24, 0, 36, 34, 44, scales, 0, 0, 0.9, 0.85);
    // Hood fins
    addBox(m, -44, -20, 8, 12, 28, 8, scales, 0, 2, 0.65);
    addBox(m, 44, -20, 8, 12, 28, 8, scales, 0, 2, 0.65);
    // Eyes
    addBox(m, -18, -34, -40, 7, 5, 4, eye, 2, 5);
    addBox(m, 18, -34, -40, 7, 5, 4, eye, 2, 5);
    // Jaw & fangs
    addBox(m, 0, 10, -16, 26, 12, 28, belly, 1, 2);
    addBox(m, -14, 0, -40, 4, 10, 4, fang, 1, 5, 0.25);
    addBox(m, 14, 0, -40, 4, 10, 4, fang, 1, 5, 0.25);
    models.set(302, encodeModelV2(m));
  }

  // --- Model 303: General Graardor Chathead ---
  {
    const m = createBuilder();
    const warSkin = hexToHsl16('#6f7466');
    const warPaint = hexToHsl16('#8f241e');
    const tusk = hexToHsl16('#dcd0b4');
    addPrismOctagonHead(m, 0, -24, 0, 42, 42, 40, warSkin, 0, 0, 1.05, 0.86);
    addBox(m, 0, -42, -37, 26, 6, 4, warPaint, 2, 4); // heavy brow ridge
    addBox(m, -16, -33, -37, 6, 4, 3, hexToHsl16('#e6b832'), 2, 5);
    addBox(m, 16, -33, -37, 6, 4, 3, hexToHsl16('#e6b832'), 2, 5);
    addBox(m, 0, 12, -14, 34, 15, 28, warSkin, 1, 2);
    addBox(m, -20, -2, -39, 5, 14, 5, tusk, 1, 5, 0.2);
    addBox(m, 20, -2, -39, 5, 14, 5, tusk, 1, 5, 0.2);
    models.set(303, encodeModelV2(m));
  }

  // --- Model 304: Bob the Cat Chathead ---
  {
    const m = createBuilder();
    const fur = hexToHsl16('#28282c');
    const earInner = hexToHsl16('#965e68');
    const catEye = hexToHsl16('#55c944');
    const nose = hexToHsl16('#bd7682');
    addPrismOctagonHead(m, 0, -18, 0, 34, 30, 32, fur, 0, 0, 0.9, 0.9);
    // Ears
    addBox(m, -22, -56, 2, 10, 14, 8, fur, 0, 3, 0.25);
    addBox(m, 22, -56, 2, 10, 14, 8, fur, 0, 3, 0.25);
    addBox(m, -22, -52, -4, 5, 9, 3, earInner, 0, 4, 0.25);
    addBox(m, 22, -52, -4, 5, 9, 3, earInner, 0, 4, 0.25);
    // Cat eyes & nose & muzzle
    addBox(m, -14, -26, -31, 6, 6, 3, catEye, 2, 5);
    addBox(m, 14, -26, -31, 6, 6, 3, catEye, 2, 5);
    addBox(m, -14, -26, -33, 2, 5, 2, 16, 2, 6);
    addBox(m, 14, -26, -33, 2, 5, 2, 16, 2, 6);
    addBox(m, 0, -12, -34, 5, 4, 4, nose, 0, 5, 0.6);
    addBox(m, 0, -2, -30, 16, 8, 8, fur, 1, 3);
    models.set(304, encodeModelV2(m));
  }

  // --- Framemaps (Index 1) & Frames (Index 0) ---
  // Framemap 10: Primary Head & Brow skeleton (group 0 = head origin/rotate, group 2 = brow translate)
  const fmHead = encodeFramemap([0, 2, 0, 1], [[0, 1, 2], [0, 1, 2], [2], [2]]);
  // Framemap 11: Secondary ChatFrame Jaw/Mouth skeleton (group 1 = jaw origin/rotate/translate)
  const fmJaw = encodeFramemap([0, 1, 2], [[1], [1], [1]]);

  const framemaps = new Map<number, Uint8Array>([
    [10, fmHead],
    [11, fmJaw],
  ]);

  // Archive 100 in Index 0: Primary head tilt/nod frames (files 0..5)
  const headFrames = new Map<number, Uint8Array>([
    [0, encodeFrame(10, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 7, dx: 0, dy: 0, dz: 0 }], 4)],
    [1, encodeFrame(10, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 7, dx: -2, dy: 2, dz: 0 }, { idx: 3, flags: 2, dx: 0, dy: -2, dz: 0 }], 4)],
    [2, encodeFrame(10, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 7, dx: 2, dy: -2, dz: 1 }], 4)],
    [3, encodeFrame(10, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 7, dx: 4, dy: 1, dz: -2 }, { idx: 3, flags: 2, dx: 0, dy: 3, dz: 0 }], 4)],
    [4, encodeFrame(10, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 7, dx: -4, dy: -1, dz: 2 }, { idx: 3, flags: 2, dx: 0, dy: -3, dz: 0 }], 4)],
    [5, encodeFrame(10, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 7, dx: 3, dy: 3, dz: 0 }, { idx: 3, flags: 2, dx: 0, dy: 2, dz: 0 }], 4)],
  ]);

  // Archive 101 in Index 0: Secondary chatFrame mouth/jaw talk frames (files 0..3)
  const jawFrames = new Map<number, Uint8Array>([
    [0, encodeFrame(11, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 2, dx: 0, dy: 0, dz: 0 }], 3)],
    [1, encodeFrame(11, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 2, dx: 0, dy: 5, dz: 0 }, { idx: 2, flags: 1, dx: -2, dy: 0, dz: 0 }], 3)],
    [2, encodeFrame(11, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 2, dx: 0, dy: 9, dz: 0 }, { idx: 2, flags: 1, dx: -3, dy: 0, dz: 0 }], 3)],
    [3, encodeFrame(11, [{ idx: 0, flags: 7, dx: 0, dy: 0, dz: 0 }, { idx: 1, flags: 2, dx: 0, dy: 3, dz: 0 }], 3)],
  ]);

  // --- Sequences (Index 2, Archive 12) ---
  const seqFiles = new Map<number, Uint8Array>([
    [591, encodeSeq({ name: 'chathead_default', frameLengths: [6, 5, 6, 5], frameIds: [(100 << 16) | 0, (100 << 16) | 1, (100 << 16) | 2, (100 << 16) | 1], chatFrameIds: [(101 << 16) | 0, (101 << 16) | 1, (101 << 16) | 2, (101 << 16) | 3] })],
    [588, encodeSeq({ name: 'chathead_happy', frameLengths: [5, 5, 5, 5], frameIds: [(100 << 16) | 1, (100 << 16) | 2, (100 << 16) | 4, (100 << 16) | 1], chatFrameIds: [(101 << 16) | 1, (101 << 16) | 2, (101 << 16) | 1, (101 << 16) | 0] })],
    [589, encodeSeq({ name: 'chathead_calm', frameLengths: [8, 8, 8, 8], frameIds: [(100 << 16) | 0, (100 << 16) | 1, (100 << 16) | 0, (100 << 16) | 2], chatFrameIds: [(101 << 16) | 0, (101 << 16) | 3, (101 << 16) | 0, (101 << 16) | 1] })],
    [592, encodeSeq({ name: 'chathead_evil', frameLengths: [4, 4, 4, 4], frameIds: [(100 << 16) | 3, (100 << 16) | 5, (100 << 16) | 3, (100 << 16) | 0], chatFrameIds: [(101 << 16) | 2, (101 << 16) | 1, (101 << 16) | 2, (101 << 16) | 3] })],
    [593, encodeSeq({ name: 'chathead_sad', frameLengths: [9, 9, 9, 9], frameIds: [(100 << 16) | 3, (100 << 16) | 3, (100 << 16) | 5, (100 << 16) | 3], chatFrameIds: [(101 << 16) | 0, (101 << 16) | 3, (101 << 16) | 0, (101 << 16) | 0] })],
    [594, encodeSeq({ name: 'chathead_angry', frameLengths: [4, 4, 4, 4], frameIds: [(100 << 16) | 5, (100 << 16) | 3, (100 << 16) | 5, (100 << 16) | 4], chatFrameIds: [(101 << 16) | 2, (101 << 16) | 0, (101 << 16) | 2, (101 << 16) | 1] })],
    [596, encodeSeq({ name: 'chathead_laugh', frameLengths: [3, 3, 3, 3, 3], frameIds: [(100 << 16) | 1, (100 << 16) | 4, (100 << 16) | 1, (100 << 16) | 4, (100 << 16) | 0], chatFrameIds: [(101 << 16) | 2, (101 << 16) | 1, (101 << 16) | 2, (101 << 16) | 1, (101 << 16) | 0] })],
  ]);

  // --- NPCs (Index 2, Archive 9) ---
  const npcFiles = new Map<number, Uint8Array>([
    [3106, encodeNpc({ name: 'Hans', models: [100], chatheadModels: [100, 110], combatLevel: 0, recolorFrom: [8741], recolorTo: [hexToHsl16('#752222')] })],
    [2108, encodeNpc({ name: 'Wise Old Man', models: [100, 111, 200], chatheadModels: [100, 111, 200], recolorFrom: [hair, 127, 8741], recolorTo: [107, hexToHsl16('#2846c8'), hexToHsl16('#2846c8')] })],
    [6077, encodeNpc({ name: 'Gnome child', models: [300], chatheadModels: [300], combatLevel: 1 })],
    [3127, encodeNpc({ name: 'TzTok-Jad', models: [301], chatheadModels: [301], combatLevel: 702 })],
    [2042, encodeNpc({ name: 'Zulrah', models: [302], chatheadModels: [302], combatLevel: 725, multiChildren: [2042, 2043, 2044] })],
    [2043, encodeNpc({ name: 'Zulrah (Magma)', models: [302], chatheadModels: [302], combatLevel: 725, recolorFrom: [33463], recolorTo: [hexToHsl16('#c43426')] })],
    [2044, encodeNpc({ name: 'Zulrah (Tanzanite)', models: [302], chatheadModels: [302], combatLevel: 725, recolorFrom: [33463], recolorTo: [hexToHsl16('#2e76d6')] })],
    [2215, encodeNpc({ name: 'General Graardor', models: [303], chatheadModels: [303], combatLevel: 624 })],
    [2802, encodeNpc({ name: 'Bob', models: [304], chatheadModels: [304], combatLevel: 0 })],
    [403, encodeNpc({ name: 'Vannaka', models: [101, 111], chatheadModels: [101, 111], recolorFrom: [hair, 8741], recolorTo: [hexToHsl16('#aa381e'), hexToHsl16('#2a2a2e')] })],
  ]);

  // --- Items (Index 2, Archive 10) ---
  const itemFiles = new Map<number, Uint8Array>([
    [1042, encodeItem({ name: 'Blue partyhat', inventoryModel: 200, maleHeadModel: 200, femaleHeadModel: 200, recolorFrom: [127], recolorTo: [hexToHsl16('#2447d6')] })],
    [1038, encodeItem({ name: 'Red partyhat', inventoryModel: 200, maleHeadModel: 200, femaleHeadModel: 200, recolorFrom: [127], recolorTo: [hexToHsl16('#c91c1c')] })],
    [1040, encodeItem({ name: 'Yellow partyhat', inventoryModel: 200, maleHeadModel: 200, femaleHeadModel: 200, recolorFrom: [127], recolorTo: [hexToHsl16('#ded222')] })],
    [1048, encodeItem({ name: 'White partyhat', inventoryModel: 200, maleHeadModel: 200, femaleHeadModel: 200 })],
    [1153, encodeItem({ name: 'Iron full helm', inventoryModel: 201, wearpos1: 0, wearpos2: 8, wearpos3: 11, maleHeadModel: 201, femaleHeadModel: 201 })],
    [1149, encodeItem({ name: 'Dragon med helm', inventoryModel: 202, wearpos1: 0, wearpos2: 8, maleHeadModel: 202, femaleHeadModel: 202 })],
    [11864, encodeItem({ name: 'Slayer helmet', inventoryModel: 203, wearpos1: 0, wearpos2: 8, wearpos3: 11, maleHeadModel: 203, femaleHeadModel: 203 })],
    [579, encodeItem({ name: 'Wizard hat', inventoryModel: 204, wearpos1: 0, maleHeadModel: 204, femaleHeadModel: 204 })],
    [2581, encodeItem({ name: 'Robin hood hat', inventoryModel: 204, wearpos1: 0, maleHeadModel: 204, femaleHeadModel: 204, recolorFrom: [hexToHsl16('#28469e')], recolorTo: [hexToHsl16('#2d7232')] })],
    [1050, encodeItem({ name: 'Santa hat', inventoryModel: 205, wearpos1: 0, maleHeadModel: 205, femaleHeadModel: 205 })],
  ]);

  // --- Kits (Index 2, Archive 3) ---
  const kitFiles = new Map<number, Uint8Array>([
    [0, encodeKit({ bodyPartId: 0, models: [100], chatheadModels: [100] })],
    [1, encodeKit({ bodyPartId: 0, models: [101], chatheadModels: [101] })],
    [2, encodeKit({ bodyPartId: 0, models: [102], chatheadModels: [102] })],
    [10, encodeKit({ bodyPartId: 1, models: [110], chatheadModels: [110] })],
    [11, encodeKit({ bodyPartId: 1, models: [111], chatheadModels: [111] })],
    [12, encodeKit({ bodyPartId: 1, models: [112], chatheadModels: [112] })],
    [45, encodeKit({ bodyPartId: 7, models: [103], chatheadModels: [103] })],
    [46, encodeKit({ bodyPartId: 7, models: [104], chatheadModels: [104] })],
  ]);

  // --- Pack into Flatcache (0.flatcache, 1.flatcache, 2.flatcache, 7.flatcache) AND .dat2/.idx* ---
  const archiveBlobs: Array<{ index: number; archive: number; fileIds: number[]; container: Uint8Array }> = [];

  const addArchive = (index: number, archive: number, map: Map<number, Uint8Array>) => {
    const entries = Array.from(map.entries());
    const packed = packMultiFileArchive(entries);
    archiveBlobs.push({
      index,
      archive,
      fileIds: packed.fileIds,
      container: packJs5(packed.data, false),
    });
  };

  addArchive(0, 100, headFrames);
  addArchive(0, 101, jawFrames);
  for (const [id, data] of framemaps.entries()) {
    archiveBlobs.push({ index: 1, archive: id, fileIds: [0], container: packJs5(data, false) });
  }
  addArchive(2, 3, kitFiles);
  addArchive(2, 9, npcFiles);
  addArchive(2, 10, itemFiles);
  addArchive(2, 12, seqFiles);
  for (const [id, data] of models.entries()) {
    archiveBlobs.push({ index: 7, archive: id, fileIds: [0], container: packJs5(data, false) });
  }

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

  // Build Abex .flatcache files
  const flatFiles = new Map<string, Uint8Array>();
  const te = new TextEncoder();
  for (const idx of [0, 1, 2, 7]) {
    const lines: string[] = ['revision=229', 'named=false', 'compression=0', 'crc=0'];
    for (const item of archiveBlobs.filter((a) => a.index === idx)) {
      lines.push(`id=${item.archive}`);
      for (const fid of item.fileIds) {
        lines.push(`file=${fid}=0`);
      }
      lines.push(`contents=${uint8ToBase64(item.container)}`);
    }
    flatFiles.set(`${idx}.flatcache`, te.encode(lines.join('\n') + '\n'));
  }

  // Build .dat2 + .idx0/.idx1/.idx2/.idx7/.idx255
  const dat2Files = buildDiskCacheBinary(archiveBlobs);

  // Build raw plain .dat files
  const rawDatFiles = new Map<string, Uint8Array>();
  for (const [id, data] of models.entries()) {
    rawDatFiles.set(`${id}.dat`, data);
  }

  return { dat2Files, flatFiles, rawDatFiles };
}

function buildDiskCacheBinary(
  blobs: Array<{ index: number; archive: number; fileIds: number[]; container: Uint8Array }>
): Map<string, Uint8Array> {
  const SECTOR_SIZE = 520;
  // Reserve sector 0 as blank null sector
  const sectors: Uint8Array[] = [new Uint8Array(SECTOR_SIZE)];
  const idxMap = new Map<number, Map<number, { size: number; sector: number }>>();

  const writeToDat2 = (index: number, archive: number, blob: Uint8Array) => {
    const startSector = sectors.length;
    const headerSize = archive > 0xffff ? 10 : 8;
    const payloadCap = SECTOR_SIZE - headerSize;
    let offset = 0;
    let part = 0;

    while (offset < blob.length) {
      const sec = new Uint8Array(SECTOR_SIZE);
      const dv = new DataView(sec.buffer);
      const chunkLen = Math.min(payloadCap, blob.length - offset);
      const isLast = offset + chunkLen >= blob.length;
      const nextSector = isLast ? 0 : sectors.length + 1;

      if (headerSize === 10) {
        dv.setInt32(0, archive, false);
        dv.setUint16(4, part, false);
        sec[6] = (nextSector >> 16) & 0xff;
        sec[7] = (nextSector >> 8) & 0xff;
        sec[8] = nextSector & 0xff;
        sec[9] = index & 0xff;
      } else {
        dv.setUint16(0, archive, false);
        dv.setUint16(2, part, false);
        sec[4] = (nextSector >> 16) & 0xff;
        sec[5] = (nextSector >> 8) & 0xff;
        sec[6] = nextSector & 0xff;
        sec[7] = index & 0xff;
      }

      sec.set(blob.subarray(offset, offset + chunkLen), headerSize);
      sectors.push(sec);
      offset += chunkLen;
      part++;
    }

    let entries = idxMap.get(index);
    if (!entries) {
      entries = new Map();
      idxMap.set(index, entries);
    }
    entries.set(archive, { size: blob.length, sector: startSector });
  };

  for (const item of blobs) {
    writeToDat2(item.index, item.archive, item.container);
  }

  // Write Index 255 reference tables for indices 0, 1, 2, 7
  for (const idxId of [0, 1, 2, 7]) {
    const arList = blobs
      .filter((b) => b.index === idxId)
      .map((b) => ({ id: b.archive, files: b.fileIds }));
    const refTable = encodeReferenceTable(229, arList);
    writeToDat2(255, idxId, packJs5(refTable, false));
  }

  const out = new Map<string, Uint8Array>();
  const totalDat = new Uint8Array(sectors.length * SECTOR_SIZE);
  for (let i = 0; i < sectors.length; i++) {
    totalDat.set(sectors[i], i * SECTOR_SIZE);
  }
  out.set('main_file_cache.dat2', totalDat);

  for (const [idxId, entries] of idxMap.entries()) {
    let maxAr = 0;
    for (const arId of entries.keys()) {
      if (arId > maxAr) maxAr = arId;
    }
    const idxBytes = new Uint8Array((maxAr + 1) * 6);
    for (const [arId, info] of entries.entries()) {
      const p = arId * 6;
      idxBytes[p] = (info.size >> 16) & 0xff;
      idxBytes[p + 1] = (info.size >> 8) & 0xff;
      idxBytes[p + 2] = info.size & 0xff;
      idxBytes[p + 3] = (info.sector >> 16) & 0xff;
      idxBytes[p + 4] = (info.sector >> 8) & 0xff;
      idxBytes[p + 5] = info.sector & 0xff;
    }
    out.set(`main_file_cache.idx${idxId}`, idxBytes);
  }

  return out;
}
