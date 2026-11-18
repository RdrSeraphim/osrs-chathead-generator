import {
  CacheProvider,
  DiskCacheProvider,
  FileProvider,
  FlatCacheProvider,
  GameVal,
  GameValID,
} from '@abextm/cache2';
import { ByteBuffer } from './ByteBuffer';
import { decompressBzip2WithoutHeader, decompressJs5 } from './decompression';
import { decodeFrame, decodeFramemap } from './decoders/FrameDecoder';
import { decodeItem } from './decoders/ItemDecoder';
import { decodeKit } from './decoders/KitDecoder';
import { decodeModel } from './decoders/ModelDecoder';
import { decodeNpc } from './decoders/NpcDecoder';
import { decodeSeq } from './decoders/SeqDecoder';
import {
  CacheFormat,
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
} from './types';

function hash317(name: string): number {
  let h = 0;
  const upper = name.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    h = (h * 61 + upper.charCodeAt(i) - 32) | 0;
  }
  return h;
}

function unpackJag317(archiveBytes: Uint8Array): Map<number, Uint8Array> {
  const buf = new ByteBuffer(archiveBytes);
  const unpackedLen = buf.u24();
  const packedLen = buf.u24();
  let data: Uint8Array;
  if (packedLen !== unpackedLen) {
    data = decompressBzip2WithoutHeader(archiveBytes.subarray(6, 6 + packedLen), unpackedLen);
  } else {
    data = archiveBytes.subarray(6, 6 + unpackedLen);
  }

  const r = new ByteBuffer(data);
  const count = r.u16();
  const entries: Array<{ hash: number; unpacked: number; packed: number }> = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      hash: r.i32(),
      unpacked: r.u24(),
      packed: r.u24(),
    });
  }

  const out = new Map<number, Uint8Array>();
  for (const e of entries) {
    const raw = r.readBytes(e.packed);
    if (e.packed !== e.unpacked) {
      out.set(e.hash, decompressBzip2WithoutHeader(raw, e.unpacked));
    } else {
      out.set(e.hash, raw);
    }
  }
  return out;
}

function parse317ConfigTable(datBytes: Uint8Array, idxBytes: Uint8Array): Map<number, Uint8Array> {
  const idx = new ByteBuffer(idxBytes);
  const count = idx.u16();
  const dat = new ByteBuffer(datBytes);
  const datCount = dat.u16();
  const n = Math.min(count, datCount);
  const out = new Map<number, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const len = idx.u16();
    const slice = dat.readBytes(len);
    if (len > 0) {
      out.set(i, slice);
    }
  }
  return out;
}

/**
 * In-memory FileMapProvider built from uploaded files or test buffers.
 */
export class MemoryFileMapProvider implements FileMapProvider {
  private readonly files = new Map<string, Uint8Array>();

  constructor(entries?: Iterable<[string, Uint8Array]>) {
    if (entries) {
      for (const [rawKey, data] of entries) {
        const key = normalizeRelPath(rawKey);
        this.files.set(key, data);
      }
    }
  }

  set(name: string, data: Uint8Array): void {
    this.files.set(normalizeRelPath(name), data);
  }

  async getFile(name: string): Promise<Uint8Array | undefined> {
    const norm = normalizeRelPath(name);
    const direct = this.files.get(norm);
    if (direct) return direct;
    // Also check basename match if nested inside a single uploaded root directory
    for (const [k, v] of this.files.entries()) {
      if (k === norm || k.endsWith('/' + norm)) {
        return v;
      }
    }
    return undefined;
  }

  async listFiles(): Promise<string[]> {
    return Array.from(this.files.keys());
  }
}

export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Adapter from FileMapProvider to @abextm/cache2's FileProvider (stripping optional single root folder).
 */
class Cache2FileProviderAdapter implements FileProvider {
  constructor(
    private readonly provider: FileMapProvider,
    private readonly prefix: string = ''
  ) {}

  async getFile(name: string): Promise<Uint8Array | undefined> {
    const target = this.prefix ? `${this.prefix}/${name}` : name;
    return this.provider.getFile(target);
  }
}

/**
 * Unified Cache implementation supporting:
 * - OSRS .dat2 + .idx* (via @abextm/cache2 DiskCacheProvider)
 * - Abex .flatcache (via @abextm/cache2 FlatCacheProvider)
 * - Directory flatcache ({index}/{archive}.dat or {index}/{archive}/{file}.dat)
 * - Legacy 317 .dat + .idx0..idx4
 * - Plain .dat files (loose config/model .dat files)
 */
export class OsrsUnifiedCache implements UnifiedCache {
  private npcsCache: Map<number, NpcDef> | null = null;
  private itemsCache: Map<number, ItemDef> | null = null;
  private kitsCache: Map<number, KitDef> | null = null;
  private seqsCache: Map<number, SeqDef> | null = null;
  private modelsCache = new Map<number, ModelDef>();
  private framesCache = new Map<string, FrameDef>();
  private framemapsCache = new Map<number, FramemapDef>();

  // For legacy 317 / raw-dat caches
  private rawNpcs = new Map<number, Uint8Array>();
  private rawItems = new Map<number, Uint8Array>();
  private rawKits = new Map<number, Uint8Array>();
  private rawSeqs = new Map<number, Uint8Array>();
  private rawModels = new Map<number, Uint8Array>();
  private rawFramemaps = new Map<number, Uint8Array>();
  private dirArchiveFiles = new Map<string, Map<number, Uint8Array>>();
  private dirArchiveIndex = new Map<number, Set<number>>();

  constructor(
    public readonly format: CacheFormat,
    public readonly sourceLabel: string,
    public readonly revision: number,
    private readonly cache2?: CacheProvider,
    private readonly fileMap?: FileMapProvider,
    private readonly prefix: string = ''
  ) {}

  static async open(
    fileMap: FileMapProvider,
    sourceLabel: string
  ): Promise<OsrsUnifiedCache> {
    const files = (await fileMap.listFiles?.()) ?? [];
    const normalized = files.map(normalizeRelPath);

    // Find optional single root prefix if user picked a parent directory
    const dat2Match = normalized.find((f) => f.endsWith('main_file_cache.dat2'));
    if (dat2Match) {
      const prefix = dat2Match.includes('/')
        ? dat2Match.slice(0, dat2Match.lastIndexOf('/'))
        : '';
      const disk = new DiskCacheProvider(new Cache2FileProviderAdapter(fileMap, prefix));
      const idx2 = await disk.getIndex(2);
      const rev = idx2?.revision ?? 0;
      return new OsrsUnifiedCache('dat2', sourceLabel, rev, disk, fileMap, prefix);
    }

    const flatMatch = normalized.find((f) => /(?:^|\/)\d+\.flatcache$/.test(f));
    if (flatMatch) {
      const prefix = flatMatch.includes('/')
        ? flatMatch.slice(0, flatMatch.lastIndexOf('/'))
        : '';
      const flat = new FlatCacheProvider(new Cache2FileProviderAdapter(fileMap, prefix));
      const idx2 = await flat.getIndex(2);
      const rev = idx2?.revision ?? 0;
      return new OsrsUnifiedCache('abex-flatcache', sourceLabel, rev, flat, fileMap, prefix);
    }

    const legacyDatMatch = normalized.find((f) => f.endsWith('main_file_cache.dat'));
    if (legacyDatMatch) {
      const prefix = legacyDatMatch.includes('/')
        ? legacyDatMatch.slice(0, legacyDatMatch.lastIndexOf('/'))
        : '';
      const cache = new OsrsUnifiedCache('legacy-dat', sourceLabel, 317, undefined, fileMap, prefix);
      await cache.initLegacyDat();
      return cache;
    }

    // Check directory-based flatcache or plain .dat files
    const hasDirFlat = normalized.some((f) =>
      /^(?:.*\/)?(0|1|2|7)\/\d+(?:\/\d+)?\.dat$/i.test(f)
    );
    const cache = new OsrsUnifiedCache(
      hasDirFlat ? 'dir-flatcache' : 'raw-dat',
      sourceLabel,
      0,
      undefined,
      fileMap,
      ''
    );
    await cache.initDirOrRawDat(normalized);
    return cache;
  }

  private async initLegacyDat(): Promise<void> {
    if (!this.fileMap) return;
    const dat = await this.getPrefixedFile('main_file_cache.dat');
    if (!dat) return;

    const readIdxArchive = async (idxNum: number, archiveId: number): Promise<Uint8Array | undefined> => {
      const idxBytes = await this.getPrefixedFile(`main_file_cache.idx${idxNum}`);
      if (!idxBytes) return undefined;
      const ptr = archiveId * 6;
      if (ptr + 6 > idxBytes.length) return undefined;
      const size = (idxBytes[ptr] << 16) | (idxBytes[ptr + 1] << 8) | idxBytes[ptr + 2];
      let sector = (idxBytes[ptr + 3] << 16) | (idxBytes[ptr + 4] << 8) | idxBytes[ptr + 5];
      if (size <= 0 || sector <= 0) return undefined;

      const out = new Uint8Array(size);
      let read = 0;
      let part = 0;
      while (read < size && sector > 0) {
        const off = sector * 520;
        if (off + 8 > dat.length) break;
        const nextArchive = (dat[off] << 8) | dat[off + 1];
        const curPart = (dat[off + 2] << 8) | dat[off + 3];
        const nextSector = (dat[off + 4] << 16) | (dat[off + 5] << 8) | dat[off + 6];
        const curIdx = dat[off + 7];
        if (nextArchive !== archiveId || curPart !== part || curIdx !== idxNum + 1) {
          break;
        }
        const chunk = Math.min(512, size - read);
        out.set(dat.subarray(off + 8, off + 8 + chunk), read);
        read += chunk;
        sector = nextSector;
        part++;
      }
      return out;
    };

    const configArchive = await readIdxArchive(0, 2);
    if (configArchive) {
      const files = unpackJag317(configArchive);
      const npcDat = files.get(hash317('npc.dat'));
      const npcIdx = files.get(hash317('npc.idx'));
      if (npcDat && npcIdx) this.rawNpcs = parse317ConfigTable(npcDat, npcIdx);

      const objDat = files.get(hash317('obj.dat'));
      const objIdx = files.get(hash317('obj.idx'));
      if (objDat && objIdx) this.rawItems = parse317ConfigTable(objDat, objIdx);

      const idkDat = files.get(hash317('idk.dat'));
      const idkIdx = files.get(hash317('idk.idx'));
      if (idkDat && idkIdx) this.rawKits = parse317ConfigTable(idkDat, idkIdx);

      const seqDat = files.get(hash317('seq.dat'));
      const seqIdx = files.get(hash317('seq.idx'));
      if (seqDat && seqIdx) this.rawSeqs = parse317ConfigTable(seqDat, seqIdx);
    }

    const idx1 = await this.getPrefixedFile('main_file_cache.idx1');
    if (idx1) {
      const total = Math.floor(idx1.length / 6);
      for (let id = 0; id < total; id++) {
        const raw = await readIdxArchive(1, id);
        if (raw && raw.length > 0) {
          this.rawModels.set(id, decompressJs5(raw));
        }
      }
    }
  }

  private async initDirOrRawDat(files: string[]): Promise<void> {
    if (!this.fileMap) return;

    // Check for unpacked 317 config files (npc.dat + npc.idx, etc.)
    const findBySuffix = (name: string) =>
      files.find((f) => f === name || f.endsWith('/' + name));

    const tryLoad317Pair = async (base: string, target: Map<number, Uint8Array>) => {
      const dPath = findBySuffix(`${base}.dat`);
      const iPath = findBySuffix(`${base}.idx`);
      if (dPath && iPath) {
        const d = await this.fileMap!.getFile(dPath);
        const idx = await this.fileMap!.getFile(iPath);
        if (d && idx) {
          for (const [k, v] of parse317ConfigTable(d, idx)) {
            target.set(k, v);
          }
        }
      }
    };

    await tryLoad317Pair('npc', this.rawNpcs);
    await tryLoad317Pair('obj', this.rawItems);
    await tryLoad317Pair('idk', this.rawKits);
    await tryLoad317Pair('seq', this.rawSeqs);

    for (const file of files) {
      // Pattern 1: {index}/{archive}/{file}.dat
      const m3 = file.match(/(?:^|\/)(\d+)\/(\d+)\/(\d+)\.dat$/i);
      if (m3) {
        const indexId = Number(m3[1]);
        const archiveId = Number(m3[2]);
        const fileId = Number(m3[3]);
        const bytes = await this.fileMap.getFile(file);
        if (bytes) {
          const decomp = decompressJs5(bytes);
          const key = `${indexId}:${archiveId}`;
          let map = this.dirArchiveFiles.get(key);
          if (!map) {
            map = new Map();
            this.dirArchiveFiles.set(key, map);
          }
          map.set(fileId, decomp);
          let set = this.dirArchiveIndex.get(indexId);
          if (!set) {
            set = new Set();
            this.dirArchiveIndex.set(indexId, set);
          }
          set.add(archiveId);
          if (indexId === 7) this.rawModels.set(archiveId, decomp);
          if (indexId === 1) this.rawFramemaps.set(archiveId, decomp);
        }
        continue;
      }

      // Pattern 2: {index}/{archive}.dat
      const m2 = file.match(/(?:^|\/)(\d+)\/(\d+)\.dat$/i);
      if (m2) {
        const indexId = Number(m2[1]);
        const archiveId = Number(m2[2]);
        const bytes = await this.fileMap.getFile(file);
        if (bytes) {
          const decomp = decompressJs5(bytes);
          if (indexId === 7) this.rawModels.set(archiveId, decomp);
          else if (indexId === 1) this.rawFramemaps.set(archiveId, decomp);
          else {
            const key = `${indexId}:${archiveId}`;
            const map = this.dirArchiveFiles.get(key) ?? new Map<number, Uint8Array>();
            map.set(0, decomp);
            this.dirArchiveFiles.set(key, map);
          }
          let set = this.dirArchiveIndex.get(indexId);
          if (!set) {
            set = new Set();
            this.dirArchiveIndex.set(indexId, set);
          }
          set.add(archiveId);
        }
        continue;
      }

      // Pattern 3: models/{id}.dat or {id}.dat (plain .dat model files)
      const mModel = file.match(/(?:^|\/)(?:models?\/)?(?:model_?)?(\d+)\.dat$/i);
      if (mModel && !/\/\d+\/\d+\.dat$/i.test(file)) {
        const modelId = Number(mModel[1]);
        const bytes = await this.fileMap.getFile(file);
        if (bytes) {
          const decomp = decompressJs5(bytes);
          if (decomp.length >= 18) {
            this.rawModels.set(modelId, decomp);
          }
        }
      }
    }
  }

  private async getPrefixedFile(name: string): Promise<Uint8Array | undefined> {
    if (!this.fileMap) return undefined;
    const p = this.prefix ? `${this.prefix}/${name}` : name;
    return this.fileMap.getFile(p);
  }

  private async loadAllConfigNpcs(): Promise<Map<number, NpcDef>> {
    if (this.npcsCache) return this.npcsCache;
    const map = new Map<number, NpcDef>();

    if (this.cache2) {
      const version = await this.cache2.getVersion(2);
      const ar = await this.cache2.getArchive(2, 9);
      if (ar) {
        for (const [id, file] of ar.getFiles().entries()) {
          if (file.data.length > 1 && file.data[0] !== 0) {
            try {
              map.set(id, decodeNpc(file.data, id, version, false));
            } catch {
              // skip malformed entry
            }
          }
        }
      }
    } else if (this.rawNpcs.size > 0) {
      for (const [id, data] of this.rawNpcs.entries()) {
        try {
          map.set(id, decodeNpc(data, id, undefined, this.format === 'legacy-dat'));
        } catch {
          // skip
        }
      }
    } else if (this.dirArchiveFiles.has('2:9')) {
      for (const [id, data] of this.dirArchiveFiles.get('2:9')!.entries()) {
        if (data.length > 1 && data[0] !== 0) {
          try {
            map.set(id, decodeNpc(data, id, undefined, false));
          } catch {
            // skip
          }
        }
      }
    } else if (this.rawModels.size > 0) {
      // Plain .dat model files only: expose each model as a synthetic NPC chathead entry so user can inspect & animate
      for (const modelId of this.rawModels.keys()) {
        map.set(modelId, {
          id: modelId,
          name: `Model #${modelId}`,
          models: [modelId],
          chatheadModels: [modelId],
          recolorFrom: [],
          recolorTo: [],
          retextureFrom: [],
          retextureTo: [],
          standingAnimation: -1,
          walkingAnimation: -1,
          combatLevel: -1,
          widthScale: 128,
          heightScale: 128,
          ambient: 0,
          contrast: 0,
          varbit: -1,
          varp: -1,
          multiChildren: [],
          oobChild: -1,
        });
      }
    }

    this.npcsCache = map;
    return map;
  }

  private async loadAllConfigItems(): Promise<Map<number, ItemDef>> {
    if (this.itemsCache) return this.itemsCache;
    const map = new Map<number, ItemDef>();

    if (this.cache2) {
      const version = await this.cache2.getVersion(2);
      const ar = await this.cache2.getArchive(2, 10);
      if (ar) {
        for (const [id, file] of ar.getFiles().entries()) {
          if (file.data.length > 1 && file.data[0] !== 0) {
            try {
              map.set(id, decodeItem(file.data, id, version, false));
            } catch {
              // skip
            }
          }
        }
      }
    } else if (this.rawItems.size > 0) {
      for (const [id, data] of this.rawItems.entries()) {
        try {
          map.set(id, decodeItem(data, id, undefined, this.format === 'legacy-dat'));
        } catch {
          // skip
        }
      }
    } else if (this.dirArchiveFiles.has('2:10')) {
      for (const [id, data] of this.dirArchiveFiles.get('2:10')!.entries()) {
        if (data.length > 1 && data[0] !== 0) {
          try {
            map.set(id, decodeItem(data, id, undefined, false));
          } catch {
            // skip
          }
        }
      }
    }

    this.itemsCache = map;
    return map;
  }

  private async loadAllConfigKits(): Promise<Map<number, KitDef>> {
    if (this.kitsCache) return this.kitsCache;
    const map = new Map<number, KitDef>();

    if (this.cache2) {
      const ar = await this.cache2.getArchive(2, 3);
      if (ar) {
        for (const [id, file] of ar.getFiles().entries()) {
          if (file.data.length > 1 && file.data[0] !== 0) {
            try {
              map.set(id, decodeKit(file.data, id));
            } catch {
              // skip
            }
          }
        }
      }
    } else if (this.rawKits.size > 0) {
      for (const [id, data] of this.rawKits.entries()) {
        try {
          map.set(id, decodeKit(data, id));
        } catch {
          // skip
        }
      }
    } else if (this.dirArchiveFiles.has('2:3')) {
      for (const [id, data] of this.dirArchiveFiles.get('2:3')!.entries()) {
        if (data.length > 1 && data[0] !== 0) {
          try {
            map.set(id, decodeKit(data, id));
          } catch {
            // skip
          }
        }
      }
    }

    this.kitsCache = map;
    return map;
  }

  private async loadAllConfigSeqs(): Promise<Map<number, SeqDef>> {
    if (this.seqsCache) return this.seqsCache;
    const map = new Map<number, SeqDef>();

    if (this.cache2) {
      const version = await this.cache2.getVersion(2);
      const ar = await this.cache2.getArchive(2, 12);
      let seqNames: Map<number, GameVal> | undefined;
      try {
        seqNames = await GameVal.all(this.cache2, 7 as GameValID);
      } catch {
        // Older caches without Index 24 GameVal
      }
      if (ar) {
        for (const [id, file] of ar.getFiles().entries()) {
          if (file.data.length > 1 && file.data[0] !== 0) {
            try {
              const decoded = decodeSeq(file.data, id, version, false);
              if (!decoded.name && seqNames) {
                const gvName = seqNames.get(id)?.name;
                if (gvName) decoded.name = gvName;
              }
              map.set(id, decoded);
            } catch {
              // skip
            }
          }
        }
      }
    } else if (this.rawSeqs.size > 0) {
      for (const [id, data] of this.rawSeqs.entries()) {
        try {
          map.set(id, decodeSeq(data, id, undefined, this.format === 'legacy-dat'));
        } catch {
          // skip
        }
      }
    } else if (this.dirArchiveFiles.has('2:12')) {
      for (const [id, data] of this.dirArchiveFiles.get('2:12')!.entries()) {
        if (data.length > 1 && data[0] !== 0) {
          try {
            map.set(id, decodeSeq(data, id, undefined, false));
          } catch {
            // skip
          }
        }
      }
    }

    this.seqsCache = map;
    return map;
  }

  async getNpcIds(): Promise<number[]> {
    return Array.from((await this.loadAllConfigNpcs()).keys());
  }

  async getNpc(id: number): Promise<NpcDef | undefined> {
    return (await this.loadAllConfigNpcs()).get(id);
  }

  async getAllNpcs(): Promise<NpcDef[]> {
    return Array.from((await this.loadAllConfigNpcs()).values());
  }

  async getItemIds(): Promise<number[]> {
    return Array.from((await this.loadAllConfigItems()).keys());
  }

  async getItem(id: number): Promise<ItemDef | undefined> {
    return (await this.loadAllConfigItems()).get(id);
  }

  async getAllItems(): Promise<ItemDef[]> {
    return Array.from((await this.loadAllConfigItems()).values());
  }

  async getKitIds(): Promise<number[]> {
    return Array.from((await this.loadAllConfigKits()).keys());
  }

  async getKit(id: number): Promise<KitDef | undefined> {
    return (await this.loadAllConfigKits()).get(id);
  }

  async getAllKits(): Promise<KitDef[]> {
    return Array.from((await this.loadAllConfigKits()).values());
  }

  async getSeqIds(): Promise<number[]> {
    return Array.from((await this.loadAllConfigSeqs()).keys());
  }

  async getSeq(id: number): Promise<SeqDef | undefined> {
    return (await this.loadAllConfigSeqs()).get(id);
  }

  async getAllSeqs(): Promise<SeqDef[]> {
    return Array.from((await this.loadAllConfigSeqs()).values());
  }

  async getModelIds(): Promise<number[]> {
    if (this.cache2) {
      return (await this.cache2.getArchives(7)) ?? [];
    }
    return Array.from(this.rawModels.keys());
  }

  async getModel(id: number): Promise<ModelDef | undefined> {
    const cached = this.modelsCache.get(id);
    if (cached) return cached;

    let bytes: Uint8Array | undefined;
    if (this.cache2) {
      const ar = await this.cache2.getArchive(7, id);
      bytes = ar?.getFile(0)?.data;
    } else {
      bytes = this.rawModels.get(id);
    }

    if (!bytes || bytes.length < 18) return undefined;
    const decoded = decodeModel(bytes, id);
    this.modelsCache.set(id, decoded);
    return decoded;
  }

  async getFramemap(id: number): Promise<FramemapDef | undefined> {
    const cached = this.framemapsCache.get(id);
    if (cached) return cached;

    let bytes: Uint8Array | undefined;
    if (this.cache2) {
      const ar = await this.cache2.getArchive(1, id);
      bytes = ar?.getFile(0)?.data;
    } else {
      bytes = this.rawFramemaps.get(id);
    }

    if (!bytes || bytes.length === 0) return undefined;
    const decoded = decodeFramemap(bytes, id);
    this.framemapsCache.set(id, decoded);
    return decoded;
  }

  async getFrame(archiveId: number, fileId: number): Promise<FrameDef | undefined> {
    const key = `${archiveId}:${fileId}`;
    const cached = this.framesCache.get(key);
    if (cached) return cached;

    let bytes: Uint8Array | undefined;
    if (this.cache2) {
      const ar = await this.cache2.getArchive(0, archiveId);
      bytes = ar?.getFile(fileId)?.data;
    } else {
      bytes = this.dirArchiveFiles.get(`0:${archiveId}`)?.get(fileId);
    }

    if (!bytes || bytes.length < 3) return undefined;
    const decoded = await decodeFrame(bytes, archiveId, fileId, (fmId) =>
      this.getFramemap(fmId)
    );
    if (decoded) {
      this.framesCache.set(key, decoded);
    }
    return decoded;
  }

  async getSummary(): Promise<CacheSummary> {
    const [npcs, items, kits, seqs, modelIds] = await Promise.all([
      this.getAllNpcs(),
      this.getAllItems(),
      this.getAllKits(),
      this.getAllSeqs(),
      this.getModelIds(),
    ]);

    return {
      format: this.format,
      sourceLabel: this.sourceLabel,
      revision: this.revision,
      npcCount: npcs.length,
      chatheadNpcCount: npcs.filter(
        (n) => n.chatheadModels.length > 0 || n.multiChildren.some((c) => c >= 0)
      ).length,
      itemCount: items.length,
      headgearItemCount: items.filter(
        (it) =>
          it.maleChatheadModel >= 0 ||
          it.femaleChatheadModel >= 0 ||
          it.maleChatheadModel1 >= 0 ||
          it.femaleChatheadModel1 >= 0
      ).length,
      kitCount: kits.length,
      seqCount: seqs.length,
      modelCount: modelIds.length,
    };
  }
}
