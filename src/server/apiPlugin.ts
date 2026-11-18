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
  activeMtimeMs: number;
  lastError: string | null;
}

const state: ServerCacheState = {
  cache: null,
  activePath: path.resolve(process.cwd(), 'cache'),
  activeMtimeMs: 0,
  lastError: null,
};

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
  if (state.cache) {
    if (state.activePath === defaultDir) {
      const mtime = await getMarkerMtimeMs(defaultDir);
      if (mtime > 0 && mtime !== state.activeMtimeMs) {
        state.cache = null;
      }
    }
    if (state.cache) return state.cache;
  }

  try {
    await fs.access(defaultDir);
    state.cache = await OsrsUnifiedCache.open(new NodeFileMapProvider(defaultDir), defaultDir);
    state.activePath = defaultDir;
    state.activeMtimeMs = await getMarkerMtimeMs(defaultDir);
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
      state.cache = await OsrsUnifiedCache.open(new NodeFileMapProvider(defaultDir), defaultDir);
      state.activePath = defaultDir;
      state.lastError = null;
      return state.cache;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }
}

async function detectCandidateCacheDirs(): Promise<string[]> {
  const candidates = [
    path.resolve(process.cwd(), 'cache'),
    path.join(os.homedir(), 'jagexcache', 'oldschool', 'LIVE'),
    path.join(os.homedir(), '.runelite', 'jagexcache', 'oldschool', 'LIVE'),
  ];
  const existing: string[] = [];
  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) existing.push(dir);
    } catch {
      // ignore missing
    }
  }
  return existing;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
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
  return {
    name: 'osrs-chathead-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;

        try {
          if (pathname === '/api/cache/status' && req.method === 'GET') {
            const cache = await ensureDefaultCacheLoaded();
            const summary = cache ? await cache.getSummary() : null;
            const candidateDirs = await detectCandidateCacheDirs();
            return sendJson(res, 200, {
              loaded: Boolean(cache),
              activePath: state.activePath,
              summary,
              candidateDirs,
              error: state.lastError,
            });
          }

          if (pathname === '/api/cache/load-path' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const dirPath = String(body.dirPath ?? '').trim();
            if (!dirPath) {
              return sendJson(res, 400, { error: 'Directory path is required.' });
            }
            const resolved = path.resolve(dirPath.replace(/^~(?=\/|$)/, os.homedir()));
            const stat = await fs.stat(resolved).catch(() => null);
            if (!stat || !stat.isDirectory()) {
              return sendJson(res, 404, { error: `Directory not found: ${resolved}` });
            }
            const cache = await OsrsUnifiedCache.open(new NodeFileMapProvider(resolved), resolved);
            state.cache = cache;
            state.activePath = resolved;
            state.lastError = null;
            const summary = await cache.getSummary();
            return sendJson(res, 200, { loaded: true, activePath: resolved, summary });
          }

          if (pathname === '/api/cache/download-openrs2' && req.method === 'POST') {
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
            const cache = await OsrsUnifiedCache.open(new NodeFileMapProvider(targetDir), targetDir);
            state.cache = cache;
            state.activePath = targetDir;
            state.activeMtimeMs = await getMarkerMtimeMs(targetDir);
            state.lastError = null;
            const summary = await cache.getSummary();
            return sendJson(res, 200, { loaded: true, activePath: targetDir, summary, openrs2Id: latest.id });
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
              [3106, 7], // Man
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

          if (pathname.startsWith('/api/player/lookup/') && req.method === 'GET') {
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
      });
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

  let foundInHiscores = false;
  let totalLevel: number | null = null;
  let combatStats: Record<string, number> | null = null;
  let accountMode = 'Normal';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const hsRes = await fetch(
      `https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=${encodeURIComponent(username)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (hsRes.ok) {
      const text = await hsRes.text();
      const lines = text.trim().split('\n');
      if (lines.length >= 8) {
        foundInHiscores = true;
        const parseLevel = (idx: number) => {
          const cols = lines[idx]?.split(',');
          return cols && cols.length >= 2 ? Number(cols[1]) : 1;
        };
        totalLevel = parseLevel(0);
        combatStats = {
          attack: parseLevel(1),
          defence: parseLevel(2),
          strength: parseLevel(3),
          hitpoints: parseLevel(4),
          ranged: parseLevel(5),
          prayer: parseLevel(6),
          magic: parseLevel(7),
        };
      }
    }
  } catch {
    // Offline or timeout: keep local fallback cleanly
  }

  // Suggest sensible iconic headgear based on stats/name when available, editable in UI
  let suggestedHelmId: number | null = null;
  const lower = username.toLowerCase();
  if (lower.includes('zezima') || lower.includes('wise')) {
    suggestedHelmId = 1042; // Blue partyhat
  } else if (combatStats && combatStats.defence >= 60 && combatStats.attack >= 60) {
    suggestedHelmId = 1149; // Dragon med helm
  } else if (combatStats && combatStats.magic >= 50) {
    suggestedHelmId = 579; // Wizard hat
  }

  return sendJson(res, 200, {
    username,
    foundInHiscores,
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
