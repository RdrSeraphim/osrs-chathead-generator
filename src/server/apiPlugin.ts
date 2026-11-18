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
import { findChatheadSequences } from '../shared/renderer/ChatheadPipeline';
import { OpenRs2CacheEntry, pickBestOpenRs2Cache } from '../../scripts/fetch-openrs2-cache';
import { NodeFileMapProvider } from './NodeFileProvider';

interface ServerCacheState {
  cache: UnifiedCache | null;
  activePath: string;
  activeLabel: string;
  activeMtimeMs: number;
  lastError: string | null;
}

const DEFAULT_CACHE_LABEL = './cache';

const state: ServerCacheState = {
  cache: null,
  activePath: path.resolve(process.cwd(), 'cache'),
  activeLabel: DEFAULT_CACHE_LABEL,
  activeMtimeMs: 0,
  lastError: null,
};

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
      }
    }
    if (state.cache) return state.cache;
  }

  try {
    await fs.access(defaultDir);
    const realDefault = await fs.realpath(defaultDir);
    state.cache = await OsrsUnifiedCache.open(new NodeFileMapProvider(realDefault), DEFAULT_CACHE_LABEL);
    state.activePath = realDefault;
    state.activeLabel = DEFAULT_CACHE_LABEL;
    state.activeMtimeMs = await getMarkerMtimeMs(realDefault);
    state.lastError = null;
    return state.cache;
  } catch {
    // Generate starter cache automatically if missing
    try {
      await fs.mkdir(defaultDir, { recursive: true });
      const built = buildStarterCache();
      for (const [name, bytes] of built.dat2Files.entries()) {
        await fs.writeFile(path.join(defaultDir, name), bytes);
      }
      const realDefault = await fs.realpath(defaultDir);
      state.cache = await OsrsUnifiedCache.open(new NodeFileMapProvider(realDefault), DEFAULT_CACHE_LABEL);
      state.activePath = realDefault;
      state.activeLabel = DEFAULT_CACHE_LABEL;
      state.activeMtimeMs = await getMarkerMtimeMs(realDefault);
      state.lastError = null;
      return state.cache;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }
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

type PreviewVariant = 'regular' | 'full' | 'chatbox';

interface StoredPreviewImage {
  bytes: Uint8Array;
  mime: 'image/gif' | 'image/png';
  token: string;
}

const ALLOWED_PREVIEW_VARIANTS = new Set<PreviewVariant>(['regular', 'full', 'chatbox']);
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 48 * 1024 * 1024;
const MAX_PREVIEW_FILES = 60;
const previewImages = new Map<PreviewVariant, StoredPreviewImage>();
const previewFilesByName = new Map<string, { bytes: Uint8Array; mime: 'image/gif' | 'image/png' }>();
let totalPreviewBytes = 0;

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

function hasValidImageMagicBytes(bytes: Uint8Array, mime: 'image/gif' | 'image/png'): boolean {
  if (mime === 'image/gif') {
    if (bytes.length < 6) return false;
    const hdr = String.fromCharCode(
      bytes[0],
      bytes[1],
      bytes[2],
      bytes[3],
      bytes[4],
      bytes[5]
    );
    return hdr === 'GIF87a' || hdr === 'GIF89a';
  }
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function storePreviewFile(
  filename: string,
  file: { bytes: Uint8Array; mime: 'image/gif' | 'image/png' }
): void {
  const existing = previewFilesByName.get(filename);
  if (existing) {
    totalPreviewBytes = Math.max(0, totalPreviewBytes - existing.bytes.length);
    previewFilesByName.delete(filename);
  }
  while (
    previewFilesByName.size >= MAX_PREVIEW_FILES ||
    (previewFilesByName.size > 0 && totalPreviewBytes + file.bytes.length > MAX_TOTAL_PREVIEW_BYTES)
  ) {
    const oldest = previewFilesByName.entries().next().value as
      | [string, { bytes: Uint8Array; mime: 'image/gif' | 'image/png' }]
      | undefined;
    if (!oldest) break;
    totalPreviewBytes = Math.max(0, totalPreviewBytes - oldest[1].bytes.length);
    previewFilesByName.delete(oldest[0]);
  }
  previewFilesByName.set(filename, file);
  totalPreviewBytes += file.bytes.length;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeded ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req, MAX_PREVIEW_BYTES);
  const text = raw.toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function normalizeImageMime(raw: string | undefined | null): 'image/gif' | 'image/png' | null {
  if (!raw) return null;
  const base = raw.split(';')[0].trim().toLowerCase();
  if (base === 'image/gif') return 'image/gif';
  if (base === 'image/png') return 'image/png';
  return null;
}

function parsePreviewVariant(raw: string): PreviewVariant | null {
  return ALLOWED_PREVIEW_VARIANTS.has(raw as PreviewVariant) ? (raw as PreviewVariant) : null;
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

export function osrsApiPlugin(): Plugin {
  const apiMiddleware = async (
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
            const body = await readJsonBody(req);
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
            state.cache = cache;
            state.activePath = matched.realPath;
            state.activeLabel = matched.label;
            state.activeMtimeMs = await getMarkerMtimeMs(matched.realPath);
            state.lastError = null;
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
            state.cache = cache;
            state.activePath = realTarget;
            state.activeLabel = DEFAULT_CACHE_LABEL;
            state.activeMtimeMs = await getMarkerMtimeMs(realTarget);
            state.lastError = null;
            const summary = await cache.getSummary();
            return sendJson(res, 200, {
              loaded: true,
              activePath: DEFAULT_CACHE_LABEL,
              summary,
              openrs2Id: latest.id,
            });
          }

          if (pathname === '/api/cache/npcs' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
            const onlyChathead = url.searchParams.get('onlyChathead') === '1';
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 150)));
            const all = await cache.getAllNpcs();
            const npcById = new Map<number, NpcDef>(all.map((n) => [n.id, n]));

            const hasEffectiveChathead = (npc: NpcDef): boolean => {
              if (npc.chatheadModels.some((m) => m >= 0 && m !== 65535)) return true;
              return npc.multiChildren.some((cid) => {
                const ch = npcById.get(cid);
                return ch ? ch.chatheadModels.some((m) => m >= 0 && m !== 65535) : false;
              });
            };

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

            const filtered: NpcDef[] = [];
            if (!q) {
              for (const fid of featuredOrder.keys()) {
                const fn = npcById.get(fid);
                if (fn && fn.name && fn.name !== 'null' && (!onlyChathead || hasEffectiveChathead(fn))) {
                  filtered.push(fn);
                }
              }
            }
            for (const n of all) {
              if (!q && featuredOrder.has(n.id)) continue;
              if (!n.name || n.name === 'null') continue;
              if (onlyChathead && !hasEffectiveChathead(n)) continue;
              if (q && !n.name.toLowerCase().includes(q) && !String(n.id).includes(q)) continue;
              filtered.push(n);
              if (filtered.length >= limit) break;
            }
            return sendJson(res, 200, { npcs: filtered, totalScanned: all.length });
          }

          if (pathname.startsWith('/api/cache/npc/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const id = Number(pathname.split('/').pop());
            const npc = await cache.getNpc(id);
            if (!npc) return sendJson(res, 404, { error: `NPC ${id} not found.` });
            return sendJson(res, 200, npc);
          }

          if (pathname === '/api/cache/items' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
            const onlyHeadgear = url.searchParams.get('onlyHeadgear') !== '0';
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 150)));
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
            const id = Number(pathname.split('/').pop());
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
            const seqs = await findChatheadSequences(cache);
            return sendJson(res, 200, { seqs });
          }

          if (pathname.startsWith('/api/cache/seq/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const id = Number(pathname.split('/').pop());
            const seq = await cache.getSeq(id);
            if (!seq) return sendJson(res, 404, { error: `Sequence ${id} not found.` });
            return sendJson(res, 200, seq);
          }

          if (pathname.startsWith('/api/cache/model/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const id = Number(pathname.split('/').pop());
            const model = await cache.getModel(id);
            if (!model) return sendJson(res, 404, { error: `Model ${id} not found.` });
            return sendJson(res, 200, serializeModel(model));
          }

          if (pathname.startsWith('/api/cache/frame/') && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            if (!cache) return sendJson(res, 503, { error: 'No cache loaded.' });
            const parts = pathname.split('/');
            const archiveId = Number(parts[parts.length - 2]);
            const fileId = Number(parts[parts.length - 1]);
            const frame = await cache.getFrame(archiveId, fileId);
            if (!frame) return sendJson(res, 404, { error: `Frame ${archiveId}:${fileId} not found.` });
            return sendJson(res, 200, frame);
          }

          if (pathname.startsWith('/api/preview-image/') && req.method === 'POST') {
            if (!checkRateLimit(clientIp, 'preview', 120, 60_000)) {
              return sendJson(res, 429, { error: 'Rate limit exceeded for preview uploads.' });
            }
            const variant = parsePreviewVariant(pathname.slice('/api/preview-image/'.length));
            if (!variant) {
              return sendJson(res, 400, { error: 'Invalid preview variant.' });
            }

            const contentType = String(req.headers?.['content-type'] ?? '');
            let token = url.searchParams.get('token')?.trim() ?? '';
            let mime = normalizeImageMime(url.searchParams.get('mime') ?? contentType);
            let bytes: Uint8Array;

            if (contentType.toLowerCase().includes('application/json')) {
              const body = await readJsonBody(req);
              if (!token) token = String(body.token ?? '').trim();
              if (!mime) mime = normalizeImageMime(typeof body.mime === 'string' ? body.mime : null);
              const b64 = typeof body.base64 === 'string' ? body.base64 : '';
              bytes = b64 ? Buffer.from(b64, 'base64') : new Uint8Array(0);
            } else {
              bytes = await readRawBody(req, MAX_PREVIEW_BYTES);
            }

            if (!mime) {
              return sendJson(res, 400, { error: 'MIME must be image/gif or image/png.' });
            }
            if (bytes.length === 0) {
              return sendJson(res, 400, { error: 'Image payload cannot be empty.' });
            }
            if (!hasValidImageMagicBytes(bytes, mime)) {
              return sendJson(res, 400, {
                error: 'Payload header does not match declared image MIME type.',
              });
            }
            if (!token || !/^[a-zA-Z0-9_-]{1,64}$/.test(token)) {
              token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
            }

            previewImages.set(variant, { bytes, mime, token });
            const ext = mime === 'image/gif' ? 'gif' : 'png';
            const filename = `osrs-${variant}-${token}.${ext}`;
            storePreviewFile(filename, { bytes, mime });
            return sendJson(res, 200, {
              url: `/api/preview-image/${filename}`,
              variant,
              mime,
              token,
              bytes: bytes.length,
            });
          }

          if (pathname.startsWith('/api/preview-image/') && (req.method === 'GET' || req.method === 'HEAD')) {
            const namedMatch =
              /^\/api\/preview-image\/(osrs-(?:regular|full|chatbox)-[a-zA-Z0-9_-]+\.(?:gif|png))$/.exec(
                pathname
              );
            let entry: { bytes: Uint8Array; mime: 'image/gif' | 'image/png' } | null = null;
            if (namedMatch) {
              entry = previewFilesByName.get(namedMatch[1]) ?? null;
            } else {
              const variantMatch = /^\/api\/preview-image\/(regular|full|chatbox)\.(gif|png)$/.exec(pathname);
              if (variantMatch) {
                const variant = variantMatch[1] as PreviewVariant;
                const ext = variantMatch[2] as 'gif' | 'png';
                const expectedMime = ext === 'gif' ? 'image/gif' : 'image/png';
                const stored = previewImages.get(variant);
                if (stored && stored.mime === expectedMime) {
                  entry = stored;
                }
              }
            }

            if (!entry) {
              if (req.method === 'HEAD') {
                res.statusCode = 404;
                res.end();
                return;
              }
              return sendJson(res, 404, { error: `Preview image not found: ${pathname}` });
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', entry.mime);
            res.setHeader('Content-Length', String(entry.bytes.length));
            res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'none'");
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            res.end(Buffer.from(entry.bytes));
            return;
          }

          if (pathname.startsWith('/api/player/lookup/') && req.method === 'GET') {
            if (!checkRateLimit(clientIp, 'hiscores', 20, 60_000)) {
              return sendJson(res, 429, { error: 'Rate limit exceeded for Hiscores lookups.' });
            }
            const rawName = decodeURIComponent(pathname.slice('/api/player/lookup/'.length)).trim();
            if (!rawName || rawName.length > 12) {
              return sendJson(res, 400, { error: 'Enter a valid OSRS username (1-12 characters).' });
            }
            return handlePlayerLookup(res, rawName);
          }

          return sendJson(res, 404, { error: `Unknown API route: ${pathname}` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const cause =
            err && typeof err === 'object' && 'cause' in err && err.cause instanceof Error
              ? ` (${err.cause.message})`
              : '';
          return sendJson(res, 500, {
            error: `${msg}${cause}`,
          });
        }
  };

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
  } else if (lower.includes('seraphim irl')) {
    suggestedHelmId = 10828;
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
