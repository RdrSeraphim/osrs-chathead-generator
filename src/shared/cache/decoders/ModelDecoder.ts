import { ByteBuffer } from '../ByteBuffer';
import { ModelDef } from '../types';

export function decodeModel(data: Uint8Array, id: number): ModelDef {
  if (data.length < 18) {
    throw new Error(`Model ${id} data too short (${data.length} bytes)`);
  }

  const def: ModelDef = {
    id,
    vertexCount: 0,
    faceCount: 0,
    numTextureFaces: 0,
    vertexPositionsX: new Int32Array(0),
    vertexPositionsY: new Int32Array(0),
    vertexPositionsZ: new Int32Array(0),
    faceVertexIndices1: new Int32Array(0),
    faceVertexIndices2: new Int32Array(0),
    faceVertexIndices3: new Int32Array(0),
    faceColors: new Uint16Array(0),
    faceRenderTypes: null,
    faceRenderPriorities: null,
    priority: 0,
    faceAlphas: null,
    vertexSkins: null,
    faceSkins: null,
    faceTextures: null,
    textureCoords: null,
    texIndices1: null,
    texIndices2: null,
    texIndices3: null,
    vertexGroups: [],
    faceLabelsAlpha: [],
    animayaGroups: null,
    animayaScales: null,
  };

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag1 = view.getInt8(data.length - 1);
  const tag2 = view.getInt8(data.length - 2);

  if (tag1 === -3 && tag2 === -1) {
    decodeType3(def, data);
  } else if (tag1 === -2 && tag2 === -1) {
    decodeType2(def, data);
  } else if (tag1 === -1 && tag2 === -1) {
    decodeType1(def, data);
  } else {
    decodeOriginal(def, data);
  }

  computeAnimationTables(def);
  return def;
}

function decodeType3(def: ModelDef, data: Uint8Array): void {
  const b1 = new ByteBuffer(data);
  const b2 = new ByteBuffer(data);
  const b3 = new ByteBuffer(data);
  const b4 = new ByteBuffer(data);
  const b5 = new ByteBuffer(data);
  const b6 = new ByteBuffer(data);
  const b7 = new ByteBuffer(data);

  b1.setPos(data.length - 26);
  const vertexCount = b1.u16();
  const faceCount = b1.u16();
  const numTexFaces = b1.u8();
  const hasFaceTypes = b1.u8();
  const priorityFlag = b1.u8();
  const hasFaceAlphas = b1.u8();
  const hasFaceSkins = b1.u8();
  const hasFaceTextures = b1.u8();
  const hasVertexSkins = b1.u8();
  const hasAnimaya = b1.u8();
  const xLen = b1.u16();
  const yLen = b1.u16();
  const zLen = b1.u16();
  const faceIndexLen = b1.u16();
  const texCoordLen = b1.u16();

  let texType0 = 0;
  let texRenderTypes: Int8Array | null = null;
  if (numTexFaces > 0) {
    texRenderTypes = new Int8Array(numTexFaces);
    b1.setPos(0);
    for (let i = 0; i < numTexFaces; i++) {
      const t = (texRenderTypes[i] = b1.i8());
      if (t === 0) texType0++;
    }
  }

  // Advance directly to vertexSkinsLen after the shared ModelDecoder header fields
  b1.setPos(data.length - 26 + 2 + 2 + 1 * 8 + 2 * 5);
  const vertexSkinsLen = b1.u16();

  let pos = numTexFaces + vertexCount;
  const offFaceTypes = pos;
  if (hasFaceTypes === 1) pos += faceCount;
  const offFaceCompress = pos;
  pos += faceCount;
  const offPriorities = pos;
  if (priorityFlag === 255) pos += faceCount;
  const offFaceSkins = pos;
  if (hasFaceSkins === 1) pos += faceCount;
  const offVertexSkins = pos;
  pos += vertexSkinsLen;
  const offAlphas = pos;
  if (hasFaceAlphas === 1) pos += faceCount;
  const offFaceIndices = pos;
  pos += faceIndexLen;
  const offFaceTextures = pos;
  if (hasFaceTextures === 1) pos += faceCount * 2;
  const offTexCoords = pos;
  pos += texCoordLen;
  const offFaceColors = pos;
  pos += faceCount * 2;
  const offVertX = pos;
  pos += xLen;
  const offVertY = pos;
  pos += yLen;
  const offVertZ = pos;
  pos += zLen;
  const offTexIdx0 = pos;
  pos += texType0 * 6;
  // unused texture metadata sizes follow

  def.vertexCount = vertexCount;
  def.faceCount = faceCount;
  def.numTextureFaces = numTexFaces;
  def.vertexPositionsX = new Int32Array(vertexCount);
  def.vertexPositionsY = new Int32Array(vertexCount);
  def.vertexPositionsZ = new Int32Array(vertexCount);
  def.faceVertexIndices1 = new Int32Array(faceCount);
  def.faceVertexIndices2 = new Int32Array(faceCount);
  def.faceVertexIndices3 = new Int32Array(faceCount);
  def.faceColors = new Uint16Array(faceCount);

  if (hasVertexSkins === 1) def.vertexSkins = new Uint8Array(vertexCount);
  if (hasFaceTypes === 1) def.faceRenderTypes = new Int8Array(faceCount);
  if (priorityFlag === 255) {
    def.faceRenderPriorities = new Int8Array(faceCount);
  } else {
    def.priority = priorityFlag;
  }
  if (hasFaceAlphas === 1) def.faceAlphas = new Uint8Array(faceCount);
  if (hasFaceSkins === 1) def.faceSkins = new Uint8Array(faceCount);
  if (hasFaceTextures === 1) def.faceTextures = new Int16Array(faceCount);
  if (hasFaceTextures === 1 && numTexFaces > 0) {
    def.textureCoords = new Int8Array(faceCount);
  }
  if (hasAnimaya === 1) {
    def.animayaGroups = new Array(vertexCount);
    def.animayaScales = new Array(vertexCount);
  }
  if (numTexFaces > 0) {
    def.texIndices1 = new Int32Array(numTexFaces);
    def.texIndices2 = new Int32Array(numTexFaces);
    def.texIndices3 = new Int32Array(numTexFaces);
  }

  // Vertices
  b1.setPos(numTexFaces);
  b2.setPos(offVertX);
  b3.setPos(offVertY);
  b4.setPos(offVertZ);
  b5.setPos(offVertexSkins);

  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = 0; i < vertexCount; i++) {
    const flags = b1.u8();
    const dx = (flags & 1) !== 0 ? b2.shortSmart() : 0;
    const dy = (flags & 2) !== 0 ? b3.shortSmart() : 0;
    const dz = (flags & 4) !== 0 ? b4.shortSmart() : 0;
    vx += dx;
    vy += dy;
    vz += dz;
    def.vertexPositionsX[i] = vx;
    def.vertexPositionsY[i] = vy;
    def.vertexPositionsZ[i] = vz;
    if (def.vertexSkins) {
      def.vertexSkins[i] = b5.u8();
    }
  }

  if (hasAnimaya === 1 && def.animayaGroups && def.animayaScales) {
    for (let i = 0; i < vertexCount; i++) {
      const len = b5.u8();
      const groups = new Array<number>(len);
      const scales = new Array<number>(len);
      for (let j = 0; j < len; j++) {
        groups[j] = b5.u8();
        scales[j] = b5.u8();
      }
      def.animayaGroups[i] = groups;
      def.animayaScales[i] = scales;
    }
  }

  // Faces
  b1.setPos(offFaceColors);
  b2.setPos(offFaceTypes);
  b3.setPos(offPriorities);
  b4.setPos(offAlphas);
  b5.setPos(offFaceSkins);
  b6.setPos(offFaceTextures);
  b7.setPos(offTexCoords);

  for (let i = 0; i < faceCount; i++) {
    def.faceColors[i] = b1.u16();
    if (def.faceRenderTypes) def.faceRenderTypes[i] = b2.i8();
    if (def.faceRenderPriorities) def.faceRenderPriorities[i] = b3.i8();
    if (def.faceAlphas) def.faceAlphas[i] = b4.u8();
    if (def.faceSkins) def.faceSkins[i] = b5.u8();
    if (def.faceTextures) def.faceTextures[i] = b6.u16() - 1;
    if (def.textureCoords && def.faceTextures && def.faceTextures[i] !== -1) {
      def.textureCoords[i] = b7.u8() - 1;
    }
  }

  decodeFaceIndices(def, data, offFaceIndices, offFaceCompress);

  if (numTexFaces > 0 && texRenderTypes && def.texIndices1 && def.texIndices2 && def.texIndices3) {
    b1.setPos(offTexIdx0);
    for (let i = 0; i < numTexFaces; i++) {
      if ((texRenderTypes[i] & 0xff) === 0) {
        def.texIndices1[i] = b1.u16();
        def.texIndices2[i] = b1.u16();
        def.texIndices3[i] = b1.u16();
      }
    }
  }
}

function decodeType2(def: ModelDef, data: Uint8Array): void {
  const b1 = new ByteBuffer(data);
  const b2 = new ByteBuffer(data);
  const b3 = new ByteBuffer(data);
  const b4 = new ByteBuffer(data);
  const b5 = new ByteBuffer(data);

  b1.setPos(data.length - 23);
  const vertexCount = b1.u16();
  const faceCount = b1.u16();
  const numTexFaces = b1.u8();
  const hasFaceTypes = b1.u8();
  const priorityFlag = b1.u8();
  const hasFaceAlphas = b1.u8();
  const hasFaceSkins = b1.u8();
  const hasVertexSkins = b1.u8();
  const hasAnimaya = b1.u8();
  const xLen = b1.u16();
  const yLen = b1.u16();
  b1.u16(); // zLen
  const faceIndexLen = b1.u16();
  const vertexSkinsLen = b1.u16();

  let pos = 0;
  pos += vertexCount;
  const offFaceCompress = pos;
  pos += faceCount;
  const offPriorities = pos;
  if (priorityFlag === 255) pos += faceCount;
  const offFaceSkins = pos;
  if (hasFaceSkins === 1) pos += faceCount;
  const offFaceTypes = pos;
  if (hasFaceTypes === 1) pos += faceCount;
  const offVertexSkins = pos;
  pos += vertexSkinsLen;
  const offAlphas = pos;
  if (hasFaceAlphas === 1) pos += faceCount;
  const offFaceIndices = pos;
  pos += faceIndexLen;
  const offFaceColors = pos;
  pos += faceCount * 2;
  const offTexIdx = pos;
  pos += numTexFaces * 6;
  const offVertX = pos;
  pos += xLen;
  const offVertY = pos;
  pos += yLen;
  const offVertZ = pos;

  initModelArrays(def, vertexCount, faceCount, numTexFaces, hasVertexSkins, hasFaceTypes, priorityFlag, hasFaceAlphas, hasFaceSkins, hasAnimaya);

  decodeVertices(def, data, 0, offVertX, offVertY, offVertZ, offVertexSkins, hasAnimaya);

  b1.setPos(offFaceColors);
  b2.setPos(offFaceTypes);
  b3.setPos(offPriorities);
  b4.setPos(offAlphas);
  b5.setPos(offFaceSkins);

  let hasShadedType = false;
  let hasTextured = false;
  for (let i = 0; i < faceCount; i++) {
    def.faceColors[i] = b1.u16();
    if (hasFaceTypes === 1 && def.faceRenderTypes && def.textureCoords && def.faceTextures) {
      const f = b2.u8();
      if ((f & 1) === 1) {
        def.faceRenderTypes[i] = 1;
        hasShadedType = true;
      } else {
        def.faceRenderTypes[i] = 0;
      }
      if ((f & 2) === 2) {
        def.textureCoords[i] = f >> 2;
        def.faceTextures[i] = def.faceColors[i];
        def.faceColors[i] = 127;
        if (def.faceTextures[i] !== -1) hasTextured = true;
      } else {
        def.textureCoords[i] = -1;
        def.faceTextures[i] = -1;
      }
    }
    if (def.faceRenderPriorities) def.faceRenderPriorities[i] = b3.i8();
    if (def.faceAlphas) def.faceAlphas[i] = b4.u8();
    if (def.faceSkins) def.faceSkins[i] = b5.u8();
  }

  decodeFaceIndices(def, data, offFaceIndices, offFaceCompress);

  if (numTexFaces > 0 && def.texIndices1 && def.texIndices2 && def.texIndices3) {
    b1.setPos(offTexIdx);
    for (let i = 0; i < numTexFaces; i++) {
      def.texIndices1[i] = b1.u16();
      def.texIndices2[i] = b1.u16();
      def.texIndices3[i] = b1.u16();
    }
  }

  if (!hasTextured) def.faceTextures = null;
  if (!hasShadedType) def.faceRenderTypes = null;
}

function decodeType1(def: ModelDef, data: Uint8Array): void {
  const b1 = new ByteBuffer(data);
  const b2 = new ByteBuffer(data);
  const b3 = new ByteBuffer(data);
  const b4 = new ByteBuffer(data);
  const b5 = new ByteBuffer(data);
  const b6 = new ByteBuffer(data);
  const b7 = new ByteBuffer(data);

  b1.setPos(data.length - 23);
  const vertexCount = b1.u16();
  const faceCount = b1.u16();
  const numTexFaces = b1.u8();
  const hasFaceTypes = b1.u8();
  const priorityFlag = b1.u8();
  const hasFaceAlphas = b1.u8();
  const hasFaceSkins = b1.u8();
  const hasFaceTextures = b1.u8();
  const hasVertexSkins = b1.u8();
  const xLen = b1.u16();
  const yLen = b1.u16();
  const zLen = b1.u16();
  const faceIndexLen = b1.u16();
  const texCoordLen = b1.u16();

  let texType0 = 0;
  let texRenderTypes: Int8Array | null = null;
  if (numTexFaces > 0) {
    texRenderTypes = new Int8Array(numTexFaces);
    b1.setPos(0);
    for (let i = 0; i < numTexFaces; i++) {
      const t = (texRenderTypes[i] = b1.i8());
      if (t === 0) texType0++;
    }
  }

  let pos = numTexFaces + vertexCount;
  const offFaceTypes = pos;
  if (hasFaceTypes === 1) pos += faceCount;
  const offFaceCompress = pos;
  pos += faceCount;
  const offPriorities = pos;
  if (priorityFlag === 255) pos += faceCount;
  const offFaceSkins = pos;
  if (hasFaceSkins === 1) pos += faceCount;
  const offVertexSkins = pos;
  if (hasVertexSkins === 1) pos += vertexCount;
  const offAlphas = pos;
  if (hasFaceAlphas === 1) pos += faceCount;
  const offFaceIndices = pos;
  pos += faceIndexLen;
  const offFaceTextures = pos;
  if (hasFaceTextures === 1) pos += faceCount * 2;
  const offTexCoords = pos;
  pos += texCoordLen;
  const offFaceColors = pos;
  pos += faceCount * 2;
  const offVertX = pos;
  pos += xLen;
  const offVertY = pos;
  pos += yLen;
  const offVertZ = pos;
  pos += zLen;
  const offTexIdx0 = pos;

  def.vertexCount = vertexCount;
  def.faceCount = faceCount;
  def.numTextureFaces = numTexFaces;
  def.vertexPositionsX = new Int32Array(vertexCount);
  def.vertexPositionsY = new Int32Array(vertexCount);
  def.vertexPositionsZ = new Int32Array(vertexCount);
  def.faceVertexIndices1 = new Int32Array(faceCount);
  def.faceVertexIndices2 = new Int32Array(faceCount);
  def.faceVertexIndices3 = new Int32Array(faceCount);
  def.faceColors = new Uint16Array(faceCount);

  if (hasVertexSkins === 1) def.vertexSkins = new Uint8Array(vertexCount);
  if (hasFaceTypes === 1) def.faceRenderTypes = new Int8Array(faceCount);
  if (priorityFlag === 255) {
    def.faceRenderPriorities = new Int8Array(faceCount);
  } else {
    def.priority = priorityFlag;
  }
  if (hasFaceAlphas === 1) def.faceAlphas = new Uint8Array(faceCount);
  if (hasFaceSkins === 1) def.faceSkins = new Uint8Array(faceCount);
  if (hasFaceTextures === 1) def.faceTextures = new Int16Array(faceCount);
  if (hasFaceTextures === 1 && numTexFaces > 0) {
    def.textureCoords = new Int8Array(faceCount);
  }
  if (numTexFaces > 0) {
    def.texIndices1 = new Int32Array(numTexFaces);
    def.texIndices2 = new Int32Array(numTexFaces);
    def.texIndices3 = new Int32Array(numTexFaces);
  }

  decodeVertices(def, data, numTexFaces, offVertX, offVertY, offVertZ, offVertexSkins, 0);

  b1.setPos(offFaceColors);
  b2.setPos(offFaceTypes);
  b3.setPos(offPriorities);
  b4.setPos(offAlphas);
  b5.setPos(offFaceSkins);
  b6.setPos(offFaceTextures);
  b7.setPos(offTexCoords);

  for (let i = 0; i < faceCount; i++) {
    def.faceColors[i] = b1.u16();
    if (def.faceRenderTypes) def.faceRenderTypes[i] = b2.i8();
    if (def.faceRenderPriorities) def.faceRenderPriorities[i] = b3.i8();
    if (def.faceAlphas) def.faceAlphas[i] = b4.u8();
    if (def.faceSkins) def.faceSkins[i] = b5.u8();
    if (def.faceTextures) def.faceTextures[i] = b6.u16() - 1;
    if (def.textureCoords && def.faceTextures && def.faceTextures[i] !== -1) {
      def.textureCoords[i] = b7.u8() - 1;
    }
  }

  decodeFaceIndices(def, data, offFaceIndices, offFaceCompress);

  if (numTexFaces > 0 && texRenderTypes && def.texIndices1 && def.texIndices2 && def.texIndices3) {
    b1.setPos(offTexIdx0);
    for (let i = 0; i < numTexFaces; i++) {
      if ((texRenderTypes[i] & 0xff) === 0) {
        def.texIndices1[i] = b1.u16();
        def.texIndices2[i] = b1.u16();
        def.texIndices3[i] = b1.u16();
      }
    }
  }
  void texType0;
}

function decodeOriginal(def: ModelDef, data: Uint8Array): void {
  const b1 = new ByteBuffer(data);
  const b2 = new ByteBuffer(data);
  const b3 = new ByteBuffer(data);
  const b4 = new ByteBuffer(data);
  const b5 = new ByteBuffer(data);

  b1.setPos(data.length - 18);
  const vertexCount = b1.u16();
  const faceCount = b1.u16();
  const numTexFaces = b1.u8();
  const hasFaceTypes = b1.u8();
  const priorityFlag = b1.u8();
  const hasFaceAlphas = b1.u8();
  const hasFaceSkins = b1.u8();
  const hasVertexSkins = b1.u8();
  const xLen = b1.u16();
  const yLen = b1.u16();
  b1.u16(); // zLen
  const faceIndexLen = b1.u16();

  let pos = 0;
  pos += vertexCount;
  const offFaceCompress = pos;
  pos += faceCount;
  const offPriorities = pos;
  if (priorityFlag === 255) pos += faceCount;
  const offFaceSkins = pos;
  if (hasFaceSkins === 1) pos += faceCount;
  const offFaceTypes = pos;
  if (hasFaceTypes === 1) pos += faceCount;
  const offVertexSkins = pos;
  if (hasVertexSkins === 1) pos += vertexCount;
  const offAlphas = pos;
  if (hasFaceAlphas === 1) pos += faceCount;
  const offFaceIndices = pos;
  pos += faceIndexLen;
  const offFaceColors = pos;
  pos += faceCount * 2;
  const offTexIdx = pos;
  pos += numTexFaces * 6;
  const offVertX = pos;
  pos += xLen;
  const offVertY = pos;
  pos += yLen;
  const offVertZ = pos;

  initModelArrays(def, vertexCount, faceCount, numTexFaces, hasVertexSkins, hasFaceTypes, priorityFlag, hasFaceAlphas, hasFaceSkins, 0);

  decodeVertices(def, data, 0, offVertX, offVertY, offVertZ, offVertexSkins, 0);

  b1.setPos(offFaceColors);
  b2.setPos(offFaceTypes);
  b3.setPos(offPriorities);
  b4.setPos(offAlphas);
  b5.setPos(offFaceSkins);

  let hasShadedType = false;
  let hasTextured = false;
  for (let i = 0; i < faceCount; i++) {
    def.faceColors[i] = b1.u16();
    if (hasFaceTypes === 1 && def.faceRenderTypes && def.textureCoords && def.faceTextures) {
      const f = b2.u8();
      if ((f & 1) === 1) {
        def.faceRenderTypes[i] = 1;
        hasShadedType = true;
      } else {
        def.faceRenderTypes[i] = 0;
      }
      if ((f & 2) === 2) {
        def.textureCoords[i] = f >> 2;
        def.faceTextures[i] = def.faceColors[i];
        def.faceColors[i] = 127;
        if (def.faceTextures[i] !== -1) hasTextured = true;
      } else {
        def.textureCoords[i] = -1;
        def.faceTextures[i] = -1;
      }
    }
    if (def.faceRenderPriorities) def.faceRenderPriorities[i] = b3.i8();
    if (def.faceAlphas) def.faceAlphas[i] = b4.u8();
    if (def.faceSkins) def.faceSkins[i] = b5.u8();
  }

  decodeFaceIndices(def, data, offFaceIndices, offFaceCompress);

  if (numTexFaces > 0 && def.texIndices1 && def.texIndices2 && def.texIndices3) {
    b1.setPos(offTexIdx);
    for (let i = 0; i < numTexFaces; i++) {
      def.texIndices1[i] = b1.u16();
      def.texIndices2[i] = b1.u16();
      def.texIndices3[i] = b1.u16();
    }
  }

  if (!hasTextured) def.faceTextures = null;
  if (!hasShadedType) def.faceRenderTypes = null;
}

function initModelArrays(
  def: ModelDef,
  vertexCount: number,
  faceCount: number,
  numTexFaces: number,
  hasVertexSkins: number,
  hasFaceTypes: number,
  priorityFlag: number,
  hasFaceAlphas: number,
  hasFaceSkins: number,
  hasAnimaya: number
): void {
  def.vertexCount = vertexCount;
  def.faceCount = faceCount;
  def.numTextureFaces = numTexFaces;
  def.vertexPositionsX = new Int32Array(vertexCount);
  def.vertexPositionsY = new Int32Array(vertexCount);
  def.vertexPositionsZ = new Int32Array(vertexCount);
  def.faceVertexIndices1 = new Int32Array(faceCount);
  def.faceVertexIndices2 = new Int32Array(faceCount);
  def.faceVertexIndices3 = new Int32Array(faceCount);
  def.faceColors = new Uint16Array(faceCount);

  if (numTexFaces > 0) {
    def.texIndices1 = new Int32Array(numTexFaces);
    def.texIndices2 = new Int32Array(numTexFaces);
    def.texIndices3 = new Int32Array(numTexFaces);
  }
  if (hasVertexSkins === 1) def.vertexSkins = new Uint8Array(vertexCount);
  if (hasFaceTypes === 1) {
    def.faceRenderTypes = new Int8Array(faceCount);
    def.textureCoords = new Int8Array(faceCount);
    def.faceTextures = new Int16Array(faceCount);
  }
  if (priorityFlag === 255) {
    def.faceRenderPriorities = new Int8Array(faceCount);
  } else {
    def.priority = priorityFlag;
  }
  if (hasFaceAlphas === 1) def.faceAlphas = new Uint8Array(faceCount);
  if (hasFaceSkins === 1) def.faceSkins = new Uint8Array(faceCount);
  if (hasAnimaya === 1) {
    def.animayaGroups = new Array(vertexCount);
    def.animayaScales = new Array(vertexCount);
  }
}

function decodeVertices(
  def: ModelDef,
  data: Uint8Array,
  offFlags: number,
  offX: number,
  offY: number,
  offZ: number,
  offSkins: number,
  hasAnimaya: number
): void {
  const bFlags = new ByteBuffer(data);
  const bX = new ByteBuffer(data);
  const bY = new ByteBuffer(data);
  const bZ = new ByteBuffer(data);
  const bSkins = new ByteBuffer(data);

  bFlags.setPos(offFlags);
  bX.setPos(offX);
  bY.setPos(offY);
  bZ.setPos(offZ);
  bSkins.setPos(offSkins);

  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = 0; i < def.vertexCount; i++) {
    const flags = bFlags.u8();
    const dx = (flags & 1) !== 0 ? bX.shortSmart() : 0;
    const dy = (flags & 2) !== 0 ? bY.shortSmart() : 0;
    const dz = (flags & 4) !== 0 ? bZ.shortSmart() : 0;
    vx += dx;
    vy += dy;
    vz += dz;
    def.vertexPositionsX[i] = vx;
    def.vertexPositionsY[i] = vy;
    def.vertexPositionsZ[i] = vz;
    if (def.vertexSkins) {
      def.vertexSkins[i] = bSkins.u8();
    }
  }

  if (hasAnimaya === 1 && def.animayaGroups && def.animayaScales) {
    for (let i = 0; i < def.vertexCount; i++) {
      const len = bSkins.u8();
      const groups = new Array<number>(len);
      const scales = new Array<number>(len);
      for (let j = 0; j < len; j++) {
        groups[j] = bSkins.u8();
        scales[j] = bSkins.u8();
      }
      def.animayaGroups[i] = groups;
      def.animayaScales[i] = scales;
    }
  }
}

function decodeFaceIndices(
  def: ModelDef,
  data: Uint8Array,
  offFaceIndices: number,
  offFaceCompress: number
): void {
  const bIdx = new ByteBuffer(data);
  const bComp = new ByteBuffer(data);
  bIdx.setPos(offFaceIndices);
  bComp.setPos(offFaceCompress);

  let a = 0;
  let b = 0;
  let c = 0;
  let last = 0;

  for (let i = 0; i < def.faceCount; i++) {
    const op = bComp.u8();
    if (op === 1) {
      a = bIdx.shortSmart() + last;
      b = bIdx.shortSmart() + a;
      c = bIdx.shortSmart() + b;
      last = c;
    } else if (op === 2) {
      b = c;
      c = bIdx.shortSmart() + last;
      last = c;
    } else if (op === 3) {
      a = c;
      c = bIdx.shortSmart() + last;
      last = c;
    } else if (op === 4) {
      const tmp = a;
      a = b;
      b = tmp;
      c = bIdx.shortSmart() + last;
      last = c;
    }
    def.faceVertexIndices1[i] = a;
    def.faceVertexIndices2[i] = b;
    def.faceVertexIndices3[i] = c;
  }
}

export function computeAnimationTables(def: ModelDef): void {
  if (def.vertexSkins) {
    let maxGroup = 0;
    for (let i = 0; i < def.vertexCount; i++) {
      if (def.vertexSkins[i] > maxGroup) maxGroup = def.vertexSkins[i];
    }
    const groups: number[][] = Array.from({ length: maxGroup + 1 }, () => []);
    for (let i = 0; i < def.vertexCount; i++) {
      groups[def.vertexSkins[i]].push(i);
    }
    def.vertexGroups = groups;
  }

  if (def.faceSkins) {
    let maxGroup = 0;
    for (let i = 0; i < def.faceCount; i++) {
      if (def.faceSkins[i] > maxGroup) maxGroup = def.faceSkins[i];
    }
    const groups: number[][] = Array.from({ length: maxGroup + 1 }, () => []);
    for (let i = 0; i < def.faceCount; i++) {
      groups[def.faceSkins[i]].push(i);
    }
    def.faceLabelsAlpha = groups;
  }
}
