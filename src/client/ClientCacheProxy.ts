import {
  CacheSummary,
  FileMapProvider,
  FrameDef,
  FramemapDef,
  ItemDef,
  KitDef,
  ModelDef,
  NpcDef,
  SeqDef,
  UnifiedCache,
} from '../shared/cache/types';
import { normalizeRelPath, OsrsUnifiedCache } from '../shared/cache/UnifiedCacheLoader';
import { CompatibleSeqEntry } from '../shared/renderer/ChatheadPipeline';

/**
 * Lazy FileMapProvider over a browser FileList (only reads bytes when requested).
 */
export class LazyBrowserFileMapProvider implements FileMapProvider {
  private readonly files = new Map<string, File>();

  constructor(fileList: FileList | File[]) {
    for (const file of Array.from(fileList)) {
      const rel = normalizeRelPath(
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      );
      this.files.set(rel, file);
    }
  }

  async listFiles(): Promise<string[]> {
    return Array.from(this.files.keys());
  }

  async getFile(name: string): Promise<Uint8Array | undefined> {
    const norm = normalizeRelPath(name);
    let file = this.files.get(norm);
    if (!file) {
      for (const [k, f] of this.files.entries()) {
        if (k === norm || k.endsWith('/' + norm)) {
          file = f;
          break;
        }
      }
    }
    if (!file) return undefined;
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }
}

export async function openBrowserCacheFromFiles(
  fileList: FileList | File[],
  label = 'Browser Folder'
): Promise<OsrsUnifiedCache> {
  const provider = new LazyBrowserFileMapProvider(fileList);
  return OsrsUnifiedCache.open(provider, label);
}

interface SerializedModel {
  id: number;
  vertexCount: number;
  faceCount: number;
  numTextureFaces: number;
  vertexPositionsX: number[];
  vertexPositionsY: number[];
  vertexPositionsZ: number[];
  faceVertexIndices1: number[];
  faceVertexIndices2: number[];
  faceVertexIndices3: number[];
  faceColors: number[];
  faceRenderTypes: number[] | null;
  faceRenderPriorities: number[] | null;
  priority: number;
  faceAlphas: number[] | null;
  vertexSkins: number[] | null;
  faceSkins: number[] | null;
  faceTextures: number[] | null;
  textureCoords: number[] | null;
  texIndices1: number[] | null;
  texIndices2: number[] | null;
  texIndices3: number[] | null;
  vertexGroups: number[][];
  faceLabelsAlpha: number[][];
  animayaGroups: number[][] | null;
  animayaScales: number[][] | null;
}

function deserializeModel(s: SerializedModel): ModelDef {
  return {
    ...s,
    vertexPositionsX: new Int32Array(s.vertexPositionsX),
    vertexPositionsY: new Int32Array(s.vertexPositionsY),
    vertexPositionsZ: new Int32Array(s.vertexPositionsZ),
    faceVertexIndices1: new Int32Array(s.faceVertexIndices1),
    faceVertexIndices2: new Int32Array(s.faceVertexIndices2),
    faceVertexIndices3: new Int32Array(s.faceVertexIndices3),
    faceColors: new Uint16Array(s.faceColors),
    faceRenderTypes: s.faceRenderTypes ? new Int8Array(s.faceRenderTypes) : null,
    faceRenderPriorities: s.faceRenderPriorities ? new Int8Array(s.faceRenderPriorities) : null,
    faceAlphas: s.faceAlphas ? new Uint8Array(s.faceAlphas) : null,
    vertexSkins: s.vertexSkins ? new Uint8Array(s.vertexSkins) : null,
    faceSkins: s.faceSkins ? new Uint8Array(s.faceSkins) : null,
    faceTextures: s.faceTextures ? new Int16Array(s.faceTextures) : null,
    textureCoords: s.textureCoords ? new Int8Array(s.textureCoords) : null,
    texIndices1: s.texIndices1 ? new Int32Array(s.texIndices1) : null,
    texIndices2: s.texIndices2 ? new Int32Array(s.texIndices2) : null,
    texIndices3: s.texIndices3 ? new Int32Array(s.texIndices3) : null,
  };
}

/**
 * Browser-side UnifiedCache proxy talking to Vite dev/prod /api/cache/* endpoints.
 */
export class ServerCacheProxy implements UnifiedCache {
  private npcCache = new Map<number, NpcDef>();
  private itemCache = new Map<number, ItemDef>();
  private modelCache = new Map<number, ModelDef>();
  private frameCache = new Map<string, FrameDef>();
  private kitsList: KitDef[] | null = null;
  private seqEntries: CompatibleSeqEntry[] | null = null;

  constructor(private readonly summaryData: CacheSummary) {}

  get format() {
    return this.summaryData.format;
  }

  get sourceLabel() {
    return this.summaryData.sourceLabel;
  }

  get revision() {
    return this.summaryData.revision;
  }

  async getSummary(): Promise<CacheSummary> {
    return this.summaryData;
  }

  async searchNpcs(q: string, onlyChathead: boolean, limit = 150): Promise<NpcDef[]> {
    const res = await fetch(
      `/api/cache/npcs?q=${encodeURIComponent(q)}&onlyChathead=${onlyChathead ? '1' : '0'}&limit=${limit}`
    );
    if (!res.ok) throw new Error('Failed to fetch NPCs');
    const json = (await res.json()) as { npcs: NpcDef[] };
    for (const n of json.npcs) this.npcCache.set(n.id, n);
    return json.npcs;
  }

  async searchItems(q: string, onlyHeadgear = true, limit = 150): Promise<ItemDef[]> {
    const res = await fetch(
      `/api/cache/items?q=${encodeURIComponent(q)}&onlyHeadgear=${onlyHeadgear ? '1' : '0'}&limit=${limit}`
    );
    if (!res.ok) throw new Error('Failed to fetch Items');
    const json = (await res.json()) as { items: ItemDef[] };
    for (const it of json.items) this.itemCache.set(it.id, it);
    return json.items;
  }

  async getSeqEntries(): Promise<CompatibleSeqEntry[]> {
    if (this.seqEntries) return this.seqEntries;
    const res = await fetch('/api/cache/seqs');
    if (!res.ok) throw new Error('Failed to fetch Sequences');
    const json = (await res.json()) as { seqs: CompatibleSeqEntry[] };
    this.seqEntries = json.seqs;
    return json.seqs;
  }

  async getNpcIds(): Promise<number[]> {
    return (await this.getAllNpcs()).map((n) => n.id);
  }

  async getNpc(id: number): Promise<NpcDef | undefined> {
    const cached = this.npcCache.get(id);
    if (cached) return cached;
    const res = await fetch(`/api/cache/npc/${id}`);
    if (!res.ok) return undefined;
    const npc = (await res.json()) as NpcDef;
    this.npcCache.set(id, npc);
    return npc;
  }

  async getAllNpcs(): Promise<NpcDef[]> {
    return this.searchNpcs('', false, 500);
  }

  async getItemIds(): Promise<number[]> {
    return (await this.getAllItems()).map((i) => i.id);
  }

  async getItem(id: number): Promise<ItemDef | undefined> {
    const cached = this.itemCache.get(id);
    if (cached) return cached;
    const res = await fetch(`/api/cache/item/${id}`);
    if (!res.ok) return undefined;
    const item = (await res.json()) as ItemDef;
    this.itemCache.set(id, item);
    return item;
  }

  async getAllItems(): Promise<ItemDef[]> {
    return this.searchItems('', true, 500);
  }

  async getKitIds(): Promise<number[]> {
    return (await this.getAllKits()).map((k) => k.id);
  }

  async getKit(id: number): Promise<KitDef | undefined> {
    const all = await this.getAllKits();
    return all.find((k) => k.id === id);
  }

  async getAllKits(): Promise<KitDef[]> {
    if (this.kitsList) return this.kitsList;
    const res = await fetch('/api/cache/kits');
    if (!res.ok) return [];
    const json = (await res.json()) as { kits: KitDef[] };
    this.kitsList = json.kits;
    return json.kits;
  }

  async getSeqIds(): Promise<number[]> {
    return (await this.getAllSeqs()).map((s) => s.id);
  }

  async getSeq(id: number): Promise<SeqDef | undefined> {
    const known = (await this.getAllSeqs()).find((s) => s.id === id);
    if (known) return known;
    const res = await fetch(`/api/cache/seq/${id}`);
    if (!res.ok) return undefined;
    return (await res.json()) as SeqDef;
  }

  async getAllSeqs(): Promise<SeqDef[]> {
    return (await this.getSeqEntries()).map((e) => e.seq);
  }

  async getModelIds(): Promise<number[]> {
    return [];
  }

  async getModel(id: number): Promise<ModelDef | undefined> {
    const cached = this.modelCache.get(id);
    if (cached) return cached;
    const res = await fetch(`/api/cache/model/${id}`);
    if (!res.ok) return undefined;
    const raw = (await res.json()) as SerializedModel;
    const model = deserializeModel(raw);
    this.modelCache.set(id, model);
    return model;
  }

  async getFrame(archiveId: number, fileId: number): Promise<FrameDef | undefined> {
    const key = `${archiveId}:${fileId}`;
    const cached = this.frameCache.get(key);
    if (cached) return cached;
    const res = await fetch(`/api/cache/frame/${archiveId}/${fileId}`);
    if (!res.ok) return undefined;
    const frame = (await res.json()) as FrameDef;
    this.frameCache.set(key, frame);
    return frame;
  }

  async getFramemap(_id: number): Promise<FramemapDef | undefined> {
    return undefined;
  }
}
