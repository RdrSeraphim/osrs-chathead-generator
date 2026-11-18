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
import type { OsrsUnifiedCache } from '../shared/cache/UnifiedCacheLoader';
import { CompatibleSeqEntry } from '../shared/renderer/ChatheadPipeline';

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

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
  const { OsrsUnifiedCache: Loader } = await import('../shared/cache/UnifiedCacheLoader');
  const provider = new LazyBrowserFileMapProvider(fileList);
  return Loader.open(provider, label);
}

const OSRS_ADMIN_TOKEN_KEY = 'osrs_admin_token';
const OSRS_LOCAL_CACHE_META_KEY = 'osrs_local_cache_meta_v1';
const OSRS_LOCAL_CACHE_DATA_KEY = 'osrs_local_cache_data_v1';
const OSRS_IDB_NAME = 'osrs_local_cache_db_v1';
const OSRS_IDB_STORE = 'files';
const LOCAL_STORAGE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

interface SavedBrowserCacheMeta {
  label: string;
  savedAt: number;
  storage: 'localStorage' | 'indexedDB';
  fileNames: string[];
}

export interface BrowserCacheSummaryMeta {
  label: string;
  savedAt: number;
  fileCount: number;
}

export function getAdminToken(): string {
  try {
    return typeof localStorage !== 'undefined' ? (localStorage.getItem(OSRS_ADMIN_TOKEN_KEY) ?? '') : '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const trimmed = token.trim();
    if (trimmed) localStorage.setItem(OSRS_ADMIN_TOKEN_KEY, trimmed);
    else localStorage.removeItem(OSRS_ADMIN_TOKEN_KEY);
  } catch {
    // ignore storage failures
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser.'));
      return;
    }
    const req = indexedDB.open(OSRS_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OSRS_IDB_STORE)) {
        db.createObjectStore(OSRS_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB cache store.'));
  });
}

async function writeFilesToIndexedDb(entries: Map<string, Uint8Array>): Promise<void> {
  const db = await openCacheDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OSRS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(OSRS_IDB_STORE);
      store.clear();
      for (const [name, data] of entries.entries()) {
        store.put(data, name);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed.'));
    });
  } finally {
    db.close();
  }
}

async function readFilesFromIndexedDb(fileNames: string[]): Promise<Array<[string, Uint8Array]>> {
  const db = await openCacheDb();
  try {
    return await new Promise<Array<[string, Uint8Array]>>((resolve, reject) => {
      const tx = db.transaction(OSRS_IDB_STORE, 'readonly');
      const store = tx.objectStore(OSRS_IDB_STORE);
      const out: Array<[string, Uint8Array]> = [];
      let pending = fileNames.length;
      if (pending === 0) {
        resolve(out);
        return;
      }
      for (const name of fileNames) {
        const req = store.get(name);
        req.onsuccess = () => {
          const val = req.result;
          if (val instanceof Uint8Array) {
            out.push([name, val]);
          } else if (val instanceof ArrayBuffer) {
            out.push([name, new Uint8Array(val)]);
          }
          pending--;
          if (pending === 0) resolve(out);
        };
        req.onerror = () => reject(req.error ?? new Error(`IndexedDB read failed for ${name}`));
      }
    });
  } finally {
    db.close();
  }
}

async function clearIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openCacheDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(OSRS_IDB_STORE, 'readwrite');
        tx.objectStore(OSRS_IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed.'));
      });
    } finally {
      db.close();
    }
  } catch {
    // ignore cleanup failures
  }
}

function readSavedMetaRaw(): SavedBrowserCacheMeta | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(OSRS_LOCAL_CACHE_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedBrowserCacheMeta>;
    if (
      typeof parsed.label !== 'string' ||
      (parsed.storage !== 'localStorage' && parsed.storage !== 'indexedDB') ||
      !Array.isArray(parsed.fileNames)
    ) {
      return null;
    }
    return {
      label: parsed.label,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      storage: parsed.storage,
      fileNames: parsed.fileNames.filter((n): n is string => typeof n === 'string'),
    };
  } catch {
    return null;
  }
}

export function getSavedBrowserCacheMeta(): BrowserCacheSummaryMeta | null {
  const meta = readSavedMetaRaw();
  if (!meta || meta.fileNames.length === 0) return null;
  return {
    label: meta.label,
    savedAt: meta.savedAt,
    fileCount: meta.fileNames.length,
  };
}

export async function saveBrowserCacheFiles(
  fileList: FileList | File[],
  label = 'Browser Folder'
): Promise<OsrsUnifiedCache> {
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;

  for (const file of Array.from(fileList)) {
    const rel = normalizeRelPath(
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    );
    const bytes = new Uint8Array(await file.arrayBuffer());
    entries.set(rel, bytes);
    totalBytes += bytes.length;
  }

  // Validate and open the cache before overwriting any existing persisted browser cache
  const { MemoryFileMapProvider, OsrsUnifiedCache: Loader } = await import(
    '../shared/cache/UnifiedCacheLoader'
  );
  const opened = await Loader.open(new MemoryFileMapProvider(entries), label);
  const fileNames = Array.from(entries.keys());
  let storageKind: 'localStorage' | 'indexedDB' = 'indexedDB';

  if (typeof localStorage !== 'undefined' && totalBytes <= LOCAL_STORAGE_CACHE_MAX_BYTES) {
    try {
      const encoded: Record<string, string> = {};
      for (const [name, bytes] of entries.entries()) {
        encoded[name] = bytesToBase64(bytes);
      }
      localStorage.setItem(OSRS_LOCAL_CACHE_DATA_KEY, JSON.stringify(encoded));
      storageKind = 'localStorage';
      await clearIndexedDb();
    } catch {
      storageKind = 'indexedDB';
    }
  }

  if (storageKind === 'indexedDB') {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(OSRS_LOCAL_CACHE_DATA_KEY);
    } catch {
      // ignore
    }
    await writeFilesToIndexedDb(entries).catch(() => undefined);
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const meta: SavedBrowserCacheMeta = {
        label,
        savedAt: Date.now(),
        storage: storageKind,
        fileNames,
      };
      localStorage.setItem(OSRS_LOCAL_CACHE_META_KEY, JSON.stringify(meta));
    }
  } catch {
    // ignore meta storage failure if browser quota is disabled
  }

  return opened;
}

export async function restoreSavedBrowserCache(): Promise<OsrsUnifiedCache | null> {
  const meta = readSavedMetaRaw();
  if (!meta || meta.fileNames.length === 0) return null;

  try {
    let entries: Array<[string, Uint8Array]> = [];
    if (meta.storage === 'localStorage') {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(OSRS_LOCAL_CACHE_DATA_KEY) : null;
      if (!raw) {
        await clearSavedBrowserCache();
        return null;
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
      entries = Object.entries(parsed).map(([name, b64]) => [name, base64ToBytes(b64)]);
    } else {
      entries = await readFilesFromIndexedDb(meta.fileNames);
    }

    if (entries.length === 0) {
      await clearSavedBrowserCache();
      return null;
    }

    const { MemoryFileMapProvider, OsrsUnifiedCache: Loader } = await import(
      '../shared/cache/UnifiedCacheLoader'
    );
    return await Loader.open(new MemoryFileMapProvider(entries), meta.label);
  } catch {
    await clearSavedBrowserCache();
    return null;
  }
}

export async function clearSavedBrowserCache(): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(OSRS_LOCAL_CACHE_META_KEY);
      localStorage.removeItem(OSRS_LOCAL_CACHE_DATA_KEY);
    }
  } catch {
    // ignore
  }
  await clearIndexedDb();
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
  private frameInFlight = new Map<string, Promise<FrameDef | undefined>>();
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
    const inflight = this.frameInFlight.get(key);
    if (inflight) return inflight;

    const req = (async () => {
      try {
        const res = await fetch(`/api/cache/frame/${archiveId}/${fileId}`);
        if (!res.ok) return undefined;
        const frame = (await res.json()) as FrameDef;
        this.frameCache.set(key, frame);
        return frame;
      } finally {
        this.frameInFlight.delete(key);
      }
    })();

    this.frameInFlight.set(key, req);
    return req;
  }

  async getFramemap(_id: number): Promise<FramemapDef | undefined> {
    return undefined;
  }
}
