import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { unzipSync } from 'fflate';
import { OsrsUnifiedCache } from '../shared/cache/UnifiedCacheLoader';
import {
  ModelDef,
  NpcDef,
  UnifiedCache,
} from '../shared/cache/types';
import { buildStarterCache } from '../shared/cache/StarterCacheBuilder';
import { CompatibleSeqEntry, findChatheadSequences } from '../shared/renderer/ChatheadPipeline';
import { OpenRs2CacheEntry, pickBestOpenRs2Cache } from '../../scripts/fetch-openrs2-cache';
import { NodeFileMapProvider } from './NodeFileProvider';

interface ServerCacheState {
  cache: UnifiedCache | null;
  activePath: string;
  activeLabel: string;
  activeMtimeMs: number;
  lastError: string | null;
  loadingPromise: Promise<UnifiedCache | null> | null;
  downloadInFlight: boolean;
  derivedForCache: UnifiedCache | null;
  npcList: NpcDef[] | null;
  npcHasChathead: Map<number, boolean> | null;
  chatheadSeqs: CompatibleSeqEntry[] | null;
}

const DEFAULT_CACHE_LABEL = './cache';

const state: ServerCacheState = {
  cache: null,
  activePath: path.resolve(process.cwd(), 'cache'),
  activeLabel: DEFAULT_CACHE_LABEL,
  activeMtimeMs: 0,
  lastError: null,
  loadingPromise: null,
  downloadInFlight: false,
  derivedForCache: null,
  npcList: null,
  npcHasChathead: null,
  chatheadSeqs: null,
};

function setActiveCache(cache: UnifiedCache, realPath: string, label: string, mtimeMs: number): void {
  state.cache = cache;
  state.activePath = realPath;
  state.activeLabel = label;
  state.activeMtimeMs = mtimeMs;
  state.lastError = null;
  state.derivedForCache = null;
  state.npcList = null;
  state.npcHasChathead = null;
  state.chatheadSeqs = null;
}

async function getDerivedNpcIndex(
  cache: UnifiedCache
): Promise<{ npcs: NpcDef[]; hasChathead: Map<number, boolean> }> {
  if (state.derivedForCache === cache && state.npcList && state.npcHasChathead) {
    return { npcs: state.npcList, hasChathead: state.npcHasChathead };
  }
  const all = await cache.getAllNpcs();
  const byId = new Map<number, NpcDef>(all.map((n) => [n.id, n]));
  const hasChathead = new Map<number, boolean>();
  for (const npc of all) {
    let ok = npc.chatheadModels.some((m) => m >= 0 && m !== 65535);
    if (!ok) {
      ok = npc.multiChildren.some((cid) => {
        const ch = byId.get(cid);
        return ch ? ch.chatheadModels.some((m) => m >= 0 && m !== 65535) : false;
      });
      if (!ok && npc.oobChild >= 0) {
        const oob = byId.get(npc.oobChild);
        ok = oob ? oob.chatheadModels.some((m) => m >= 0 && m !== 65535) : false;
      }
    }
    hasChathead.set(npc.id, ok);
  }
  state.derivedForCache = cache;
  state.npcList = all;
  state.npcHasChathead = hasChathead;
  state.chatheadSeqs = null;
  return { npcs: all, hasChathead };
}

async function getDerivedSeqs(cache: UnifiedCache): Promise<CompatibleSeqEntry[]> {
  if (state.derivedForCache === cache && state.chatheadSeqs) {
    return state.chatheadSeqs;
  }
  const seqs = await findChatheadSequences(cache);
  if (state.derivedForCache !== cache) {
    state.derivedForCache = cache;
    state.npcList = null;
    state.npcHasChathead = null;
  }
  state.chatheadSeqs = seqs;
  return seqs;
}

interface AllowedCacheDir {
  id: string;
  label: string;
  realPath: string;
}

async function getMarkerMtimeMs(dir: string): Promise<number> {
  for (const name of ['main_file_cache.dat2', 'main_file_cache.dat', '0.flatcache']) {
    try {
      const st = await fs.stat(path.join(dir, name));
      return st.mtimeMs;
    } catch {
      // check next
    }
  }
  return 0;
}

async function ensureDefaultCacheLoaded(): Promise<UnifiedCache | null> {
  const defaultDir = path.resolve(process.cwd(), 'cache');
  const resolvedDefault = await fs.realpath(defaultDir).catch(() => defaultDir);
  if (state.cache) {
    if (state.activePath === resolvedDefault || state.activePath === defaultDir) {
      const mtime = await getMarkerMtimeMs(defaultDir);
      if (mtime > 0 && mtime !== state.activeMtimeMs) {
        state.cache = null;
        state.derivedForCache = null;
        state.npcList = null;
        state.npcHasChathead = null;
        state.chatheadSeqs = null;
      }
    }
    if (state.cache) return state.cache;
  }

  if (state.loadingPromise) {
    return state.loadingPromise;
  }

  state.loadingPromise = (async () => {
    try {
      await fs.access(defaultDir);
      const realDefault = await fs.realpath(defaultDir);
      const cache = await OsrsUnifiedCache.open(
        new NodeFileMapProvider(realDefault),
        DEFAULT_CACHE_LABEL
      );
      setActiveCache(cache, realDefault, DEFAULT_CACHE_LABEL, await getMarkerMtimeMs(realDefault));
      return cache;
    } catch {
      // Generate starter cache automatically if missing
      try {
        await fs.mkdir(defaultDir, { recursive: true });
        const built = buildStarterCache();
        for (const [name, bytes] of built.dat2Files.entries()) {
          await fs.writeFile(path.join(defaultDir, name), bytes);
        }
        const realDefault = await fs.realpath(defaultDir);
        const cache = await OsrsUnifiedCache.open(
          new NodeFileMapProvider(realDefault),
          DEFAULT_CACHE_LABEL
        );
        setActiveCache(cache, realDefault, DEFAULT_CACHE_LABEL, await getMarkerMtimeMs(realDefault));
        return cache;
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        return null;
      }
    } finally {
      state.loadingPromise = null;
    }
  })();

  return state.loadingPromise;
}

async function getAllowedCacheDirs(): Promise<AllowedCacheDir[]> {
  const candidates: Array<{ id: string; label: string; dir: string }> = [
    { id: 'default', label: DEFAULT_CACHE_LABEL, dir: path.resolve(process.cwd(), 'cache') },
  ];

  // Host Jagex/RuneLite cache directories are opt-in for private single-user deployments only
  if (process.env.OSRS_ALLOW_HOST_CACHES === '1') {
    candidates.push(
      {
        id: 'jagexcache',
        label: '~/jagexcache/oldschool/LIVE',
        dir: path.join(os.homedir(), 'jagexcache', 'oldschool', 'LIVE'),
      },
      {
        id: 'runelite',
        label: '~/.runelite/jagexcache/oldschool/LIVE',
        dir: path.join(os.homedir(), '.runelite', 'jagexcache', 'oldschool', 'LIVE'),
      }
    );
  }

  const allowed: AllowedCacheDir[] = [];
  for (const item of candidates) {
    try {
      const realPath = await fs.realpath(item.dir);
      const stat = await fs.stat(realPath);
      if (stat.isDirectory()) {
        allowed.push({ id: item.id, label: item.label, realPath });
      }
    } catch {
      // ignore missing/unreadable candidate
    }
  }
  return allowed;
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const rateLimitBuckets = new Map<string, number[]>();

function checkRateLimit(ip: string, bucket: string, maxReqs: number, windowMs: number): boolean {
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const cutoff = now - windowMs;
  const timestamps = (rateLimitBuckets.get(key) ?? []).filter((t) => t > cutoff);
  if (timestamps.length >= maxReqs) {
    rateLimitBuckets.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  if (!rateLimitBuckets.has(key) && rateLimitBuckets.size >= 1000) {
    const oldestKey = rateLimitBuckets.keys().next().value;
    if (oldestKey !== undefined) rateLimitBuckets.delete(oldestKey);
  }
  rateLimitBuckets.set(key, timestamps);
  return true;
}

function getClientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === '1') {
    const headers = req.headers ?? {};
    const cfIp = headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) {
      return cfIp.trim();
    }
    const xff = headers['x-forwarded-for'];
    const first = typeof xff === 'string' ? xff.split(',')[0].trim() : '';
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'local';
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  const secFetchSiteRaw = headers['sec-fetch-site'];
  const secFetchSite =
    typeof secFetchSiteRaw === 'string' ? secFetchSiteRaw.trim().toLowerCase() : '';
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false;
  }

  const originRaw = headers.origin;
  if (typeof originRaw === 'string' && originRaw.trim()) {
    if (originRaw.trim() === 'null') return false;
    try {
      const originHost = new URL(originRaw).host.toLowerCase();
      const hostRaw = headers.host;
      const reqHost = typeof hostRaw === 'string' ? hostRaw.trim().toLowerCase() : '';
      if (reqHost && originHost !== reqHost) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  if (headers['x-forwarded-for'] || headers.forwarded) {
    return false;
  }
  const remote = req.socket?.remoteAddress;
  return (
    remote === undefined ||
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1'
  );
}

function isAdminAuthorized(req: IncomingMessage): boolean {
  const configuredToken = process.env.OSRS_ADMIN_TOKEN?.trim();
  if (configuredToken) {
    const rawHeader = req.headers?.['x-osrs-admin-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader.trim() : '';
    if (!provided) return false;
    const expectedBuf = Buffer.from(configuredToken, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    return (
      expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
    );
  }
  return isLoopbackRequest(req);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error(`Request body exceeded ${MAX_JSON_BODY_BYTES} bytes.`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function parseNonNegativeIntParam(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function serializeModel(m: ModelDef) {
  return {
    ...m,
    vertexPositionsX: Array.from(m.vertexPositionsX),
    vertexPositionsY: Array.from(m.vertexPositionsY),
    vertexPositionsZ: Array.from(m.vertexPositionsZ),
    faceVertexIndices1: Array.from(m.faceVertexIndices1),
    faceVertexIndices2: Array.from(m.faceVertexIndices2),
    faceVertexIndices3: Array.from(m.faceVertexIndices3),
    faceColors: Array.from(m.faceColors),
    faceRenderTypes: m.faceRenderTypes ? Array.from(m.faceRenderTypes) : null,
    faceRenderPriorities: m.faceRenderPriorities ? Array.from(m.faceRenderPriorities) : null,
    faceAlphas: m.faceAlphas ? Array.from(m.faceAlphas) : null,
    vertexSkins: m.vertexSkins ? Array.from(m.vertexSkins) : null,
    faceSkins: m.faceSkins ? Array.from(m.faceSkins) : null,
    faceTextures: m.faceTextures ? Array.from(m.faceTextures) : null,
    textureCoords: m.textureCoords ? Array.from(m.textureCoords) : null,
    texIndices1: m.texIndices1 ? Array.from(m.texIndices1) : null,
    texIndices2: m.texIndices2 ? Array.from(m.texIndices2) : null,
    texIndices3: m.texIndices3 ? Array.from(m.texIndices3) : null,
  };
}

export type ApiMiddlewareFn = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
) => Promise<void> | void;

export function createApiMiddleware(): ApiMiddlewareFn {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ) => {
        if (!req.url || !req.url.startsWith('/api/')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;
        const clientIp = getClientIp(req);

        try {
          if (req.method === 'POST' && !isSameOriginRequest(req)) {
            return sendJson(res, 403, { error: 'Cross-origin POST requests are not allowed.' });
          }

          if (pathname === '/api/cache/status' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            const summary = cache ? await cache.getSummary() : null;
            const candidateDirs = (await getAllowedCacheDirs()).map((c) => c.label);
            return sendJson(res, 200, {
              loaded: Boolean(cache),
              activePath: state.activeLabel,
              summary,
              candidateDirs,
              error: state.lastError,
            });
          }

          if (pathname === '/api/cache/load-path' && req.method === 'POST') {
            if (!isAdminAuthorized(req)) {
              return sendJson(res, 403, { error: 'Admin authorization required to switch server cache.' });
            }
            const ct = String(req.headers?.['content-type'] ?? '').toLowerCase();
            if (!ct.includes('application/json')) {
              return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
            }
            let body: Record<string, unknown>;
            try {
              body = await readJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: 'Invalid JSON request body.' });
            }
            const rawInput = String(body.dirPath ?? '').trim();
            if (!rawInput) {
              return sendJson(res, 400, { error: 'Cache source identifier is required.' });
            }
            const allowed = await getAllowedCacheDirs();
            let matched = allowed.find((a) => a.id === rawInput || a.label === rawInput);
            if (!matched) {
              const candidateReal = await fs
                .realpath(path.resolve(rawInput.replace(/^~(?=\/|$)/, os.homedir())))
                .catch(() => null);
              if (candidateReal) {
                matched = allowed.find((a) => a.realPath === candidateReal);
              }
            }
            if (!matched) {
              return sendJson(res, 403, {
                error: 'Access denied: directory is outside the server cache allowlist.',
              });
            }
            const cache = await OsrsUnifiedCache.open(
              new NodeFileMapProvider(matched.realPath),
              matched.label
            );
            setActiveCache(cache, matched.realPath, matched.label, await getMarkerMtimeMs(matched.realPath));
            const summary = await cache.getSummary();
            return sendJson(res, 200, { loaded: true, activePath: matched.label, summary });
          }

          if (pathname === '/api/cache/download-openrs2' && req.method === 'POST') {
            if (!isAdminAuthorized(req)) {
              return sendJson(res, 403, { error: 'Admin authorization required to download server cache.' });
            }
            if (!checkRateLimit(clientIp, 'openrs2', 2, 60_000)) {
              return sendJson(res, 429, { error: 'Rate limit exceeded for OpenRS2 downloads.' });
            }
            if (state.downloadInFlight) {
              return sendJson(res, 409, { error: 'A cache download is already in progress.' });
            }
            state.downloadInFlight = true;
            try {
              const listRes = await fetch('https://archive.openrs2.org/caches.json');
              if (!listRes.ok) {
                return sendJson(res, 502, { error: `OpenRS2 returned HTTP ${listRes.status}` });
              }
              const caches = (await listRes.json()) as OpenRs2CacheEntry[];
              const latest = pickBestOpenRs2Cache(caches);
              if (!latest) {
                return sendJson(res, 404, { error: 'No Old School cache found on OpenRS2.' });
              }
              const zipUrl = `https://archive.openrs2.org/caches/${encodeURIComponent(latest.scope || 'runescape')}/${latest.id}/disk.zip`;
              const zipRes = await fetch(zipUrl);
              if (!zipRes.ok) {
                return sendJson(res, 502, { error: `OpenRS2 disk.zip returned HTTP ${zipRes.status}` });
              }
              const zipBuf = new Uint8Array(await zipRes.arrayBuffer());
              const unzipped = unzipSync(zipBuf);
              const targetDir = path.resolve(process.cwd(), 'cache');
              await fs.mkdir(targetDir, { recursive: true });
              for (const [entryPath, data] of Object.entries(unzipped)) {
                if (data.length === 0) continue;
                const base = path.basename(entryPath);
                if (base.startsWith('main_file_cache.') || base === 'xteas.json') {
                  await fs.writeFile(path.join(targetDir, base), data);
                }
              }
              const realTarget = await fs.realpath(targetDir);
              const cache = await OsrsUnifiedCache.open(
                new NodeFileMapProvider(realTarget),
                DEFAULT_CACHE_LABEL
              );
              setActiveCache(cache, realTarget, DEFAULT_CACHE_LABEL, await getMarkerMtimeMs(realTarget));
              const summary = await cache.getSummary();
              return sendJson(res, 200, {
                loaded: true,
                activePath: DEFAULT_CACHE_LABEL,
                summary,
                openrs2Id: latest.id,
              });
            } finally {
              state.downloadInFlight = false;
            }
          }

          if (pathname === '/api/cache/npcs' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
            const onlyChathead = url.searchParams.get('onlyChathead') === '1';
            const rawLimit = Number(url.searchParams.get('limit') ?? 150);
            const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 150;
            const { npcs: all, hasChathead } = await getDerivedNpcIndex(cache);

            const featuredOrder = new Map<number, number>([
              [3105, 0], // Hans
              [2108, 1], // Wise Old Man
              [6077, 2], // Gnome child
              [815, 3],  // Duke Horacio
              [5892, 4], // TzRek-Jad
              [6632, 5], // General Graardor Jr.
              [2635, 6], // Bob
              [16895, 7], // Odd Old Man
              [2875, 8], // Zeke
              [3106, 9], // Man
            ]);

            const byId = !q ? new Map<number, NpcDef>(all.map((n) => [n.id, n])) : null;
            const filtered: NpcDef[] = [];
            if (!q && byId) {
              for (const fid of featuredOrder.keys()) {
                const fn = byId.get(fid);
                if (fn && fn.name && fn.name !== 'null' && (!onlyChathead || hasChathead.get(fn.id))) {
                  filtered.push(fn);
                }
              }
            }
            for (const n of all) {
              if (!q && featuredOrder.has(n.id)) continue;
              if (!n.name || n.name === 'null') continue;
              if (onlyChathead && !hasChathead.get(n.id)) continue;
              if (q && !n.name.toLowerCase().includes(q) && !String(n.id).includes(q)) continue;
              filtered.push(n);
              if (filtered.length >= limit) break;
            }
            return sendJson(res, 200, { npcs: filtered, totalScanned: all.length });
          }

          if (pathname.startsWith('/api/cache/npc/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const id = parseNonNegativeIntParam(pathname.slice('/api/cache/npc/'.length));
            if (id === null) return sendJson(res, 400, { error: 'Invalid NPC ID.' });
            const npc = await cache.getNpc(id);
            if (!npc) return sendJson(res, 404, { error: `NPC ${id} not found.` });
            return sendJson(res, 200, npc);
          }

          if (pathname === '/api/cache/items' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
            const onlyHeadgear = url.searchParams.get('onlyHeadgear') !== '0';
            const rawLimit = Number(url.searchParams.get('limit') ?? 150);
            const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 150;
            const all = await cache.getAllItems();
            const filtered = [];
            for (const it of all) {
              if (!it.name || it.name === 'null' || it.noteTemplate >= 0 || it.placeholderTemplate >= 0) continue;
              if (
                onlyHeadgear &&
                it.maleChatheadModel < 0 &&
                it.femaleChatheadModel < 0 &&
                it.maleChatheadModel1 < 0 &&
                it.femaleChatheadModel1 < 0
              ) {
                continue;
              }
              if (q && !it.name.toLowerCase().includes(q) && !String(it.id).includes(q)) continue;
              filtered.push(it);
              if (filtered.length >= limit) break;
            }
            return sendJson(res, 200, { items: filtered });
          }

          if (pathname.startsWith('/api/cache/item/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const id = parseNonNegativeIntParam(pathname.slice('/api/cache/item/'.length));
            if (id === null) return sendJson(res, 400, { error: 'Invalid Item ID.' });
            const item = await cache.getItem(id);
            if (!item) return sendJson(res, 404, { error: `Item ${id} not found.` });
            return sendJson(res, 200, item);
          }

          if (pathname === '/api/cache/kits' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const kits = await cache.getAllKits();
            return sendJson(res, 200, { kits });
          }

          if (pathname === '/api/cache/seqs' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const seqs = await getDerivedSeqs(cache);
            return sendJson(res, 200, { seqs });
          }

          if (pathname.startsWith('/api/cache/seq/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const id = parseNonNegativeIntParam(pathname.slice('/api/cache/seq/'.length));
            if (id === null) return sendJson(res, 400, { error: 'Invalid Sequence ID.' });
            const seq = await cache.getSeq(id);
            if (!seq) return sendJson(res, 404, { error: `Sequence ${id} not found.` });
            return sendJson(res, 200, seq);
          }

          if (pathname.startsWith('/api/cache/model/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const id = parseNonNegativeIntParam(pathname.slice('/api/cache/model/'.length));
            if (id === null) return sendJson(res, 400, { error: 'Invalid Model ID.' });
            const model = await cache.getModel(id);
            if (!model) return sendJson(res, 404, { error: `Model ${id} not found.` });
            return sendJson(res, 200, serializeModel(model));
          }

          if (pathname.startsWith('/api/cache/frame/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const parts = pathname.slice('/api/cache/frame/'.length).split('/');
            if (parts.length !== 2) {
              return sendJson(res, 400, { error: 'Invalid frame path.' });
            }
            const archiveId = parseNonNegativeIntParam(parts[0]);
            const fileId = parseNonNegativeIntParam(parts[1]);
            if (archiveId === null || fileId === null) {
              return sendJson(res, 400, { error: 'Invalid archive or file ID.' });
            }
            const frame = await cache.getFrame(archiveId, fileId);
            if (!frame) return sendJson(res, 404, { error: `Frame ${archiveId}:${fileId} not found.` });
            return sendJson(res, 200, frame);
          }

          if (pathname.startsWith('/api/player/lookup/') && req.method === 'GET') {
            if (!checkRateLimit(clientIp, 'hiscores', 20, 60_000)) {
              return sendJson(res, 429, { error: 'Rate limit exceeded for Hiscores lookups.' });
            }
            let rawName: string;
            try {
              rawName = decodeURIComponent(pathname.slice('/api/player/lookup/'.length)).trim();
            } catch {
              return sendJson(res, 400, { error: 'Invalid URL encoding in username.' });
            }
            if (!rawName || rawName.length > 12) {
              return sendJson(res, 400, { error: 'Enter a valid OSRS username (1-12 characters).' });
            }
            return handlePlayerLookup(res, rawName);
          }

          return sendJson(res, 404, { error: `Unknown API route: ${pathname}` });
        } catch (err) {
          console.error('[osrs-api]', err);
          return sendJson(res, 500, {
            error: 'Internal server error.',
          });
        }
  };
}

export function osrsApiPlugin(): Plugin {
  const apiMiddleware = createApiMiddleware();

  return {
    name: 'osrs-chathead-api',
    configureServer(server) {
      server.middlewares.use(apiMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware);
    },
  };
}

async function handlePlayerLookup(res: ServerResponse, username: string): Promise<void> {
  // Deterministic fallback seed from username + live OSRS Hiscores check
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.toLowerCase().charCodeAt(i)) | 0;
  }
  const absHash = Math.abs(hash);

  interface ParsedHiscore {
    username: string;
    totalLevel: number | null;
    combatStats: Record<string, number>;
  }

  let resolvedUsername = username;
  let foundInHiscores = false;
  let totalLevel: number | null = null;
  let combatStats: Record<string, number> | null = null;
  const accountMode = 'Normal';
  let networkError: string | null = null;

  const headers = { 'User-Agent': 'OSRS-Chathead-Generator/1.0' };
  const encodedName = encodeURIComponent(username);

  const tryJsonHiscores = async (): Promise<ParsedHiscore | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const hsRes = await fetch(
        `https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=${encodedName}`,
        { signal: controller.signal, headers }
      );
      if (hsRes.status === 404) return null;
      if (!hsRes.ok) throw new Error(`HTTP ${hsRes.status}`);
      const json = (await hsRes.json()) as {
        name?: string;
        skills?: Array<{ id: number; name: string; level: number }>;
      };
      const skills = json.skills ?? [];
      if (skills.length < 8) return null;
      const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s.level]));
      return {
        username: json.name || username,
        totalLevel: byName.get('overall') ?? skills[0]?.level ?? null,
        combatStats: {
          attack: byName.get('attack') ?? skills[1]?.level ?? 1,
          defence: byName.get('defence') ?? skills[2]?.level ?? 1,
          strength: byName.get('strength') ?? skills[3]?.level ?? 1,
          hitpoints: byName.get('hitpoints') ?? skills[4]?.level ?? 10,
          ranged: byName.get('ranged') ?? skills[5]?.level ?? 1,
          prayer: byName.get('prayer') ?? skills[6]?.level ?? 1,
          magic: byName.get('magic') ?? skills[7]?.level ?? 1,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const tryWsHiscores = async (): Promise<ParsedHiscore | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const hsRes = await fetch(
        `https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=${encodedName}`,
        { signal: controller.signal, headers }
      );
      if (hsRes.status === 404) return null;
      if (!hsRes.ok) throw new Error(`HTTP ${hsRes.status}`);
      const text = await hsRes.text();
      const lines = text.trim().split('\n');
      if (lines.length < 8) return null;
      const parseLevel = (idx: number) => {
        const cols = lines[idx]?.split(',');
        return cols && cols.length >= 2 ? Number(cols[1]) : 1;
      };
      return {
        username,
        totalLevel: parseLevel(0),
        combatStats: {
          attack: parseLevel(1),
          defence: parseLevel(2),
          strength: parseLevel(3),
          hitpoints: parseLevel(4),
          ranged: parseLevel(5),
          prayer: parseLevel(6),
          magic: parseLevel(7),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const parsed = (await tryJsonHiscores()) ?? (await tryWsHiscores());
    if (parsed) {
      resolvedUsername = parsed.username;
      foundInHiscores = true;
      totalLevel = parsed.totalLevel;
      combatStats = parsed.combatStats;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause =
      err && typeof err === 'object' && 'cause' in err && err.cause instanceof Error
        ? ` (${err.cause.message})`
        : '';
    networkError = `${msg}${cause}`;
  }

  // Suggest sensible iconic headgear based on stats/name when available, editable in UI
  let suggestedHelmId: number | null = null;
  const lower = resolvedUsername.toLowerCase();
  if (lower.includes('zezima') || lower.includes('wise')) {
    suggestedHelmId = 1042; // Blue partyhat
  } else if (combatStats && combatStats.defence >= 60 && combatStats.attack >= 60) {
    suggestedHelmId = 1149; // Dragon med helm
  } else if (combatStats && combatStats.magic >= 50) {
    suggestedHelmId = 579; // Wizard hat
  }

  return sendJson(res, 200, {
    username: resolvedUsername,
    foundInHiscores,
    networkError,
    accountMode,
    totalLevel,
    combatStats,
    appearanceNote:
      'Standard OSRS Hiscores does not expose worn equipment or Makeover Mage colors; customize hair, jaw, headgear, and HSL colors below.',
    suggested: {
      gender: 'male',
      headIndex: absHash % 3,
      jawIndex: absHash % 3,
      skinIndex: absHash % 6,
      hairIndex: absHash % 8,
      helmItemId: suggestedHelmId,
    },
  });
}
