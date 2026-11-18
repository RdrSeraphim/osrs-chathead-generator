export type CacheFormat =
  | 'dat2'
  | 'abex-flatcache'
  | 'dir-flatcache'
  | 'legacy-dat'
  | 'raw-dat';

export interface FileMapProvider {
  getFile(name: string): Promise<Uint8Array | undefined>;
  listFiles?(): Promise<string[]>;
}

export interface NpcDef {
  id: number;
  name: string;
  models: number[];
  chatheadModels: number[];
  recolorFrom: number[];
  recolorTo: number[];
  retextureFrom: number[];
  retextureTo: number[];
  standingAnimation: number;
  walkingAnimation: number;
  combatLevel: number;
  widthScale: number;
  heightScale: number;
  ambient: number;
  contrast: number;
  varbit: number;
  varp: number;
  multiChildren: number[];
  oobChild: number;
}

export interface ItemDef {
  id: number;
  name: string;
  inventoryModel: number;
  wearpos1: number;
  wearpos2: number;
  wearpos3: number;
  maleChatheadModel: number;
  femaleChatheadModel: number;
  maleChatheadModel1: number;
  femaleChatheadModel1: number;
  recolorFrom: number[];
  recolorTo: number[];
  retextureFrom: number[];
  retextureTo: number[];
  noteLinkedItem: number;
  noteTemplate: number;
  placeholderLinkedItem: number;
  placeholderTemplate: number;
}

export interface KitDef {
  id: number;
  bodyPartId: number;
  models: number[];
  chatheadModels: number[];
  recolorFrom: number[];
  recolorTo: number[];
  retextureFrom: number[];
  retextureTo: number[];
  nonSelectable: boolean;
}

export interface SeqDef {
  id: number;
  name?: string;
  frameLengths: number[];
  frameIds: number[];
  chatFrameIds: number[];
  frameStep: number;
  interleaveLeave?: number[];
  animMayaId: number;
  animMayaStart: number;
  animMayaEnd: number;
}

export interface ModelDef {
  id: number;
  vertexCount: number;
  faceCount: number;
  numTextureFaces: number;
  vertexPositionsX: Int32Array;
  vertexPositionsY: Int32Array;
  vertexPositionsZ: Int32Array;
  faceVertexIndices1: Int32Array;
  faceVertexIndices2: Int32Array;
  faceVertexIndices3: Int32Array;
  faceColors: Uint16Array;
  faceRenderTypes: Int8Array | null;
  faceRenderPriorities: Int8Array | null;
  priority: number;
  faceAlphas: Uint8Array | null;
  vertexSkins: Uint8Array | null;
  faceSkins: Uint8Array | null;
  faceTextures: Int16Array | null;
  textureCoords: Int8Array | null;
  texIndices1: Int32Array | null;
  texIndices2: Int32Array | null;
  texIndices3: Int32Array | null;
  vertexGroups: number[][];
  faceLabelsAlpha: number[][];
  animayaGroups: number[][] | null;
  animayaScales: number[][] | null;
}

export interface FramemapDef {
  id: number;
  length: number;
  types: number[];
  frameMaps: number[][];
}

export interface FrameDef {
  id: number;
  archiveId: number;
  fileId: number;
  framemapId: number;
  framemap?: FramemapDef;
  indexFrameIds: number[];
  translatorX: number[];
  translatorY: number[];
  translatorZ: number[];
  showing: boolean;
  colorTransform: boolean;
}

export interface CacheSummary {
  format: CacheFormat;
  sourceLabel: string;
  revision: number;
  npcCount: number;
  chatheadNpcCount: number;
  itemCount: number;
  headgearItemCount: number;
  kitCount: number;
  seqCount: number;
  modelCount: number;
}

export interface UnifiedCache {
  readonly format: CacheFormat;
  readonly sourceLabel: string;
  readonly revision: number;
  getNpcIds(): Promise<number[]>;
  getNpc(id: number): Promise<NpcDef | undefined>;
  getAllNpcs(): Promise<NpcDef[]>;
  getItemIds(): Promise<number[]>;
  getItem(id: number): Promise<ItemDef | undefined>;
  getAllItems(): Promise<ItemDef[]>;
  getKitIds(): Promise<number[]>;
  getKit(id: number): Promise<KitDef | undefined>;
  getAllKits(): Promise<KitDef[]>;
  getSeqIds(): Promise<number[]>;
  getSeq(id: number): Promise<SeqDef | undefined>;
  getAllSeqs(): Promise<SeqDef[]>;
  getModel(id: number): Promise<ModelDef | undefined>;
  getModelIds(): Promise<number[]>;
  getFrame(archiveId: number, fileId: number): Promise<FrameDef | undefined>;
  getFramemap(id: number): Promise<FramemapDef | undefined>;
  getSummary(): Promise<CacheSummary>;
}
