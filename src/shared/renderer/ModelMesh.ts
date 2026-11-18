import { FrameDef, FramemapDef, ModelDef } from '../cache/types';
import { adjustHslLightness, COSINE, SINE } from './OsrsMath';

export interface ColorOverride {
  from: number;
  to: number;
}

export interface SubModelInput {
  model: ModelDef;
  recolorFrom?: number[];
  recolorTo?: number[];
  retextureFrom?: number[];
  retextureTo?: number[];
}

export interface LitMesh {
  vertexCount: number;
  faceCount: number;
  verticesX: Int32Array;
  verticesY: Int32Array;
  verticesZ: Int32Array;
  faceA: Int32Array;
  faceB: Int32Array;
  faceC: Int32Array;
  faceHslA: Int32Array;
  faceHslB: Int32Array;
  faceHslC: Int32Array;
  faceAlphas: Uint8Array | null;
  facePriorities: Int8Array | null;
  defaultPriority: number;
  faceTextures: Int16Array | null;
  baseColors: Uint16Array;
  vertexGroups: number[][];
  faceLabelsAlpha: number[][];
}

export function mergeAndLightModels(
  inputs: SubModelInput[],
  extraRecolors: ColorOverride[] = [],
  ambientOffset = 0,
  contrastOffset = 0
): LitMesh {
  let totalVertices = 0;
  let totalFaces = 0;
  for (const inp of inputs) {
    totalVertices += inp.model.vertexCount;
    totalFaces += inp.model.faceCount;
  }

  const verticesX = new Int32Array(totalVertices);
  const verticesY = new Int32Array(totalVertices);
  const verticesZ = new Int32Array(totalVertices);
  const faceA = new Int32Array(totalFaces);
  const faceB = new Int32Array(totalFaces);
  const faceC = new Int32Array(totalFaces);
  const baseColors = new Uint16Array(totalFaces);
  const faceRenderTypes = new Int8Array(totalFaces);
  const facePriorities = new Int8Array(totalFaces);
  const faceAlphas = new Uint8Array(totalFaces);
  const faceTextures = new Int16Array(totalFaces);
  faceTextures.fill(-1);

  const vertexGroupsMap = new Map<number, number[]>();
  const faceLabelsMap = new Map<number, number[]>();

  let vOffset = 0;
  let fOffset = 0;
  let hasAnyAlpha = false;
  let hasAnyPriority = false;
  let hasAnyTexture = false;
  let defaultPriority = 0;

  // Build extra recolor map
  const extraMap = new Map<number, number>();
  for (const ov of extraRecolors) {
    extraMap.set(ov.from & 0xffff, ov.to & 0xffff);
  }

  for (const inp of inputs) {
    const m = inp.model;
    const localRecolor = new Map<number, number>();
    if (inp.recolorFrom && inp.recolorTo) {
      const len = Math.min(inp.recolorFrom.length, inp.recolorTo.length);
      for (let i = 0; i < len; i++) {
        localRecolor.set(inp.recolorFrom[i] & 0xffff, inp.recolorTo[i] & 0xffff);
      }
    }
    const localRetexture = new Map<number, number>();
    if (inp.retextureFrom && inp.retextureTo) {
      const len = Math.min(inp.retextureFrom.length, inp.retextureTo.length);
      for (let i = 0; i < len; i++) {
        localRetexture.set(inp.retextureFrom[i], inp.retextureTo[i]);
      }
    }

    for (let v = 0; v < m.vertexCount; v++) {
      verticesX[vOffset + v] = m.vertexPositionsX[v];
      verticesY[vOffset + v] = m.vertexPositionsY[v];
      verticesZ[vOffset + v] = m.vertexPositionsZ[v];
    }

    for (let g = 0; g < m.vertexGroups.length; g++) {
      const grp = m.vertexGroups[g];
      if (!grp || grp.length === 0) continue;
      let target = vertexGroupsMap.get(g);
      if (!target) {
        target = [];
        vertexGroupsMap.set(g, target);
      }
      for (let k = 0; k < grp.length; k++) {
        target.push(vOffset + grp[k]);
      }
    }

    for (let g = 0; g < m.faceLabelsAlpha.length; g++) {
      const grp = m.faceLabelsAlpha[g];
      if (!grp || grp.length === 0) continue;
      let target = faceLabelsMap.get(g);
      if (!target) {
        target = [];
        faceLabelsMap.set(g, target);
      }
      for (let k = 0; k < grp.length; k++) {
        target.push(fOffset + grp[k]);
      }
    }

    for (let f = 0; f < m.faceCount; f++) {
      const idx = fOffset + f;
      faceA[idx] = m.faceVertexIndices1[f] + vOffset;
      faceB[idx] = m.faceVertexIndices2[f] + vOffset;
      faceC[idx] = m.faceVertexIndices3[f] + vOffset;

      let color = m.faceColors[f] & 0xffff;
      if (localRecolor.has(color)) {
        color = localRecolor.get(color)!;
      }
      if (extraMap.has(color)) {
        color = extraMap.get(color)!;
      }
      baseColors[idx] = color;

      faceRenderTypes[idx] = m.faceRenderTypes ? m.faceRenderTypes[f] : 0;

      if (m.faceRenderPriorities) {
        facePriorities[idx] = m.faceRenderPriorities[f];
        hasAnyPriority = true;
      } else {
        facePriorities[idx] = m.priority;
        defaultPriority = m.priority;
      }

      if (m.faceAlphas) {
        const a = m.faceAlphas[f];
        faceAlphas[idx] = a;
        if (a !== 0) hasAnyAlpha = true;
      }

      if (m.faceTextures) {
        let texId = m.faceTextures[f];
        if (texId !== -1 && localRetexture.has(texId)) {
          texId = localRetexture.get(texId)!;
        }
        faceTextures[idx] = texId;
        if (texId !== -1) hasAnyTexture = true;
      }
    }

    vOffset += m.vertexCount;
    fOffset += m.faceCount;
  }

  let maxVGroup = 0;
  for (const k of vertexGroupsMap.keys()) {
    if (k > maxVGroup) maxVGroup = k;
  }
  const vertexGroups: number[][] = Array.from({ length: maxVGroup + 1 }, (_, i) => vertexGroupsMap.get(i) ?? []);

  let maxFGroup = 0;
  for (const k of faceLabelsMap.keys()) {
    if (k > maxFGroup) maxFGroup = k;
  }
  const faceLabelsAlpha: number[][] = Array.from({ length: maxFGroup + 1 }, (_, i) => faceLabelsMap.get(i) ?? []);

  // Compute vertex normals & merge normals across shared coordinates (seamless multi-part chatheads)
  const vNormX = new Float64Array(totalVertices);
  const vNormY = new Float64Array(totalVertices);
  const vNormZ = new Float64Array(totalVertices);
  const vNormMag = new Int32Array(totalVertices);

  const fNormX = new Float64Array(totalFaces);
  const fNormY = new Float64Array(totalFaces);
  const fNormZ = new Float64Array(totalFaces);

  for (let f = 0; f < totalFaces; f++) {
    const ia = faceA[f];
    const ib = faceB[f];
    const ic = faceC[f];

    const dxAB = verticesX[ib] - verticesX[ia];
    const dyAB = verticesY[ib] - verticesY[ia];
    const dzAB = verticesZ[ib] - verticesZ[ia];

    const dxAC = verticesX[ic] - verticesX[ia];
    const dyAC = verticesY[ic] - verticesY[ia];
    const dzAC = verticesZ[ic] - verticesZ[ia];

    let nx = dyAB * dzAC - dyAC * dzAB;
    let ny = dzAB * dxAC - dzAC * dxAB;
    let nz = dxAB * dyAC - dxAC * dyAB;

    while (nx > 8192 || ny > 8192 || nz > 8192 || nx < -8192 || ny < -8192 || nz < -8192) {
      nx /= 2;
      ny /= 2;
      nz /= 2;
    }

    let len = Math.floor(Math.sqrt(nx * nx + ny * ny + nz * nz));
    if (len <= 0) len = 1;

    nx = Math.trunc((nx * 256) / len);
    ny = Math.trunc((ny * 256) / len);
    nz = Math.trunc((nz * 256) / len);

    fNormX[f] = nx;
    fNormY[f] = ny;
    fNormZ[f] = nz;

    const rType = faceRenderTypes[f];
    if (rType === 0) {
      vNormX[ia] += nx;
      vNormY[ia] += ny;
      vNormZ[ia] += nz;
      vNormMag[ia]++;

      vNormX[ib] += nx;
      vNormY[ib] += ny;
      vNormZ[ib] += nz;
      vNormMag[ib]++;

      vNormX[ic] += nx;
      vNormY[ic] += ny;
      vNormZ[ic] += nz;
      vNormMag[ic]++;
    }
  }

  // Merge normals for identical vertex coordinates (matches ModelData.mergeNormals across sub-models)
  const coordMap = new Map<string, number[]>();
  for (let v = 0; v < totalVertices; v++) {
    if (vNormMag[v] === 0) continue;
    const key = `${verticesX[v]},${verticesY[v]},${verticesZ[v]}`;
    let list = coordMap.get(key);
    if (!list) {
      list = [v];
      coordMap.set(key, list);
    } else {
      list.push(v);
    }
  }

  for (const list of coordMap.values()) {
    if (list.length <= 1) continue;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let sm = 0;
    for (const idx of list) {
      sx += vNormX[idx];
      sy += vNormY[idx];
      sz += vNormZ[idx];
      sm += vNormMag[idx];
    }
    for (const idx of list) {
      vNormX[idx] = sx;
      vNormY[idx] = sy;
      vNormZ[idx] = sz;
      vNormMag[idx] = sm;
    }
  }

  // Lighting: authentic OSRS ModelData.light(64, 768, -50, -10, -50)
  const ambient = 64 + ambientOffset;
  const contrast = 768 + contrastOffset;
  const lightX = -50;
  const lightY = -10;
  const lightZ = -50;
  const lightDist = Math.floor(Math.sqrt(lightX * lightX + lightY * lightY + lightZ * lightZ));
  const lightMag = Math.max(1, (contrast * lightDist) >> 8);

  const faceHslA = new Int32Array(totalFaces);
  const faceHslB = new Int32Array(totalFaces);
  const faceHslC = new Int32Array(totalFaces);

  const computeVertexLight = (vIdx: number): number => {
    const mag = vNormMag[vIdx];
    if (mag === 0) return ambient;
    const dot = lightX * vNormX[vIdx] + lightY * vNormY[vIdx] + lightZ * vNormZ[vIdx];
    return ambient + Math.trunc(dot / (lightMag * mag));
  };

  for (let f = 0; f < totalFaces; f++) {
    const rType = faceRenderTypes[f];
    const baseHsl = baseColors[f];

    if (rType === 0) {
      faceHslA[f] = adjustHslLightness(baseHsl, computeVertexLight(faceA[f]));
      faceHslB[f] = adjustHslLightness(baseHsl, computeVertexLight(faceB[f]));
      faceHslC[f] = adjustHslLightness(baseHsl, computeVertexLight(faceC[f]));
    } else if (rType === 1) {
      const dot = lightX * fNormX[f] + lightY * fNormY[f] + lightZ * fNormZ[f];
      const light = ambient + Math.trunc(dot / lightMag);
      faceHslA[f] = adjustHslLightness(baseHsl, light);
      faceHslB[f] = faceHslA[f];
      faceHslC[f] = -1; // Flat shaded sentinel
    } else {
      // Hidden / shadow face
      faceHslC[f] = -2;
    }
  }

  return {
    vertexCount: totalVertices,
    faceCount: totalFaces,
    verticesX,
    verticesY,
    verticesZ,
    faceA,
    faceB,
    faceC,
    faceHslA,
    faceHslB,
    faceHslC,
    faceAlphas: hasAnyAlpha ? faceAlphas : null,
    facePriorities: hasAnyPriority ? facePriorities : null,
    defaultPriority,
    faceTextures: hasAnyTexture ? faceTextures : null,
    baseColors,
    vertexGroups,
    faceLabelsAlpha,
  };
}

export interface AnimatedVertices {
  verticesX: Int32Array;
  verticesY: Int32Array;
  verticesZ: Int32Array;
  faceAlphas: Uint8Array | null;
}

/**
 * Apply primary FrameDef and optional secondary chatFrameDef (SequenceDefinition.animateWidget).
 */
export function animateMesh(
  mesh: LitMesh,
  primaryFrame?: FrameDef,
  chatFrame?: FrameDef
): AnimatedVertices {
  const vx = new Int32Array(mesh.verticesX);
  const vy = new Int32Array(mesh.verticesY);
  const vz = new Int32Array(mesh.verticesZ);
  let alphas: Uint8Array | null = mesh.faceAlphas ? new Uint8Array(mesh.faceAlphas) : null;

  if (primaryFrame && primaryFrame.framemap) {
    alphas = applySingleFrame(
      vx,
      vy,
      vz,
      alphas,
      mesh.vertexGroups,
      mesh.faceLabelsAlpha,
      mesh.faceCount,
      primaryFrame.framemap,
      primaryFrame
    );
  }

  if (chatFrame && chatFrame.framemap) {
    alphas = applySingleFrame(
      vx,
      vy,
      vz,
      alphas,
      mesh.vertexGroups,
      mesh.faceLabelsAlpha,
      mesh.faceCount,
      chatFrame.framemap,
      chatFrame
    );
  }

  return {
    verticesX: vx,
    verticesY: vy,
    verticesZ: vz,
    faceAlphas: alphas,
  };
}

function applySingleFrame(
  vx: Int32Array,
  vy: Int32Array,
  vz: Int32Array,
  alphas: Uint8Array | null,
  vertexGroups: number[][],
  faceLabelsAlpha: number[][],
  faceCount: number,
  framemap: FramemapDef,
  frame: FrameDef
): Uint8Array | null {
  let originX = 0;
  let originY = 0;
  let originZ = 0;

  for (let i = 0; i < frame.indexFrameIds.length; i++) {
    const boneIdx = frame.indexFrameIds[i];
    const type = framemap.types[boneIdx];
    const skinList = framemap.frameMaps[boneIdx];
    if (!skinList) continue;

    const dx = frame.translatorX[i];
    const dy = frame.translatorY[i];
    const dz = frame.translatorZ[i];

    if (type === 0) {
      let count = 0;
      originX = 0;
      originY = 0;
      originZ = 0;
      for (let j = 0; j < skinList.length; j++) {
        const groupIdx = skinList[j];
        if (groupIdx < vertexGroups.length) {
          const verts = vertexGroups[groupIdx];
          for (let k = 0; k < verts.length; k++) {
            const v = verts[k];
            originX += vx[v];
            originY += vy[v];
            originZ += vz[v];
            count++;
          }
        }
      }
      if (count > 0) {
        originX = dx + Math.trunc(originX / count);
        originY = dy + Math.trunc(originY / count);
        originZ = dz + Math.trunc(originZ / count);
      } else {
        originX = dx;
        originY = dy;
        originZ = dz;
      }
    } else if (type === 1) {
      for (let j = 0; j < skinList.length; j++) {
        const groupIdx = skinList[j];
        if (groupIdx < vertexGroups.length) {
          const verts = vertexGroups[groupIdx];
          for (let k = 0; k < verts.length; k++) {
            const v = verts[k];
            vx[v] += dx;
            vy[v] += dy;
            vz[v] += dz;
          }
        }
      }
    } else if (type === 2) {
      const rx = (dx & 255) << 3;
      const ry = (dy & 255) << 3;
      const rz = (dz & 255) << 3;
      const sinX = SINE[rx];
      const cosX = COSINE[rx];
      const sinY = SINE[ry];
      const cosY = COSINE[ry];
      const sinZ = SINE[rz];
      const cosZ = COSINE[rz];

      for (let j = 0; j < skinList.length; j++) {
        const groupIdx = skinList[j];
        if (groupIdx < vertexGroups.length) {
          const verts = vertexGroups[groupIdx];
          for (let k = 0; k < verts.length; k++) {
            const v = verts[k];
            let x = vx[v] - originX;
            let y = vy[v] - originY;
            let z = vz[v] - originZ;

            if (rz !== 0) {
              const nx = (sinZ * y + cosZ * x) >> 16;
              y = (cosZ * y - sinZ * x) >> 16;
              x = nx;
            }
            if (rx !== 0) {
              const ny = (cosX * y - sinX * z) >> 16;
              z = (sinX * y + cosX * z) >> 16;
              y = ny;
            }
            if (ry !== 0) {
              const nx = (sinY * z + cosY * x) >> 16;
              z = (cosY * z - sinY * x) >> 16;
              x = nx;
            }

            vx[v] = x + originX;
            vy[v] = y + originY;
            vz[v] = z + originZ;
          }
        }
      }
    } else if (type === 3) {
      for (let j = 0; j < skinList.length; j++) {
        const groupIdx = skinList[j];
        if (groupIdx < vertexGroups.length) {
          const verts = vertexGroups[groupIdx];
          for (let k = 0; k < verts.length; k++) {
            const v = verts[k];
            vx[v] = Math.trunc(((vx[v] - originX) * dx) / 128) + originX;
            vy[v] = Math.trunc(((vy[v] - originY) * dy) / 128) + originY;
            vz[v] = Math.trunc(((vz[v] - originZ) * dz) / 128) + originZ;
          }
        }
      }
    } else if (type === 5) {
      if (!alphas) {
        alphas = new Uint8Array(faceCount);
      }
      for (let j = 0; j < skinList.length; j++) {
        const groupIdx = skinList[j];
        if (groupIdx < faceLabelsAlpha.length) {
          const faces = faceLabelsAlpha[groupIdx];
          for (let k = 0; k < faces.length; k++) {
            const f = faces[k];
            let a = alphas[f] + dx * 8;
            if (a < 0) a = 0;
            if (a > 255) a = 255;
            alphas[f] = a;
          }
        }
      }
    }
  }

  return alphas;
}

/**
 * Extract unique base 16-bit HSL colors present across a LitMesh (sorted by face count descending).
 */
export function extractPaletteFromMesh(mesh: LitMesh): Array<{ hsl: number; count: number }> {
  const counts = new Map<number, number>();
  for (let f = 0; f < mesh.faceCount; f++) {
    if (mesh.faceHslC[f] === -2) continue;
    const c = mesh.baseColors[f];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([hsl, count]) => ({ hsl, count }))
    .sort((a, b) => b.count - a.count);
}
