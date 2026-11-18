import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { buildStarterCache } from '../cache/StarterCacheBuilder';
import { MemoryFileMapProvider, OsrsUnifiedCache } from '../cache/UnifiedCacheLoader';
import {
  computeSequenceUnionBounds,
  renderAnimatedFrame,
  renderAnimatedFramePair,
  renderSequenceFrames,
  resolveNpcChathead,
  resolvePlayerChathead,
} from '../renderer/ChatheadPipeline';
import { CHATBOX_HEIGHT, CHATBOX_WIDTH, renderChatbox, stackChatboxes } from '../renderer/ChatboxRenderer';
import { encodeAnimatedGif } from '../renderer/GifExporter';
import {
  measureOpaqueBounds,
  OSRS_NPC_CHATHEAD_CAMERA,
  OSRS_PLAYER_CHATHEAD_CAMERA,
} from '../renderer/SoftwareRasterizer';
import { NodeFileMapProvider } from '../../server/NodeFileProvider';
import { osrsApiPlugin } from '../../server/apiPlugin';
import { applySocialMetaUrls, resolvePublicOrigin } from '../../server/socialMeta';
import { FONT_QUILL_8, measureBitmapText, wrapBitmapText } from '../constants/bitmapFonts';

function createApiMiddlewareInvoker() {
  type MiddlewareFn = (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void
  ) => Promise<void> | void;

  let middleware: MiddlewareFn | null = null;
  let previewMiddleware: MiddlewareFn | null = null;
  const plugin = osrsApiPlugin();
  const configureServer = plugin.configureServer as unknown as (server: {
    middlewares: { use: (fn: MiddlewareFn) => void };
  }) => void;
  const configurePreviewServer = plugin.configurePreviewServer as unknown as (server: {
    middlewares: { use: (fn: MiddlewareFn) => void };
  }) => void;
  configureServer({
    middlewares: {
      use: (fn) => {
        middleware = fn;
      },
    },
  });
  expect(typeof configurePreviewServer).toBe('function');
  configurePreviewServer({
    middlewares: {
      use: (fn) => {
        previewMiddleware = fn;
      },
    },
  });
  expect(middleware).not.toBeNull();
  expect(previewMiddleware).not.toBeNull();

  return async (
    method: string,
    reqUrl: string,
    headers: Record<string, string> = {},
    body?: Uint8Array | string
  ) => {
    const rawBuf =
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : Buffer.from(body);
    const stream = Readable.from(rawBuf ? [rawBuf] : []);
    const req = Object.assign(stream, {
      method,
      url: reqUrl,
      headers,
    }) as unknown as IncomingMessage;

    const resHeaders = new Map<string, string>();
    let endedBody: Uint8Array = new Uint8Array(0);
    const res = {
      statusCode: 200,
      setHeader: (k: string, v: string) => {
        resHeaders.set(k.toLowerCase(), String(v));
      },
      end: (chunk?: Buffer | Uint8Array | string) => {
        if (chunk !== undefined) {
          endedBody =
            typeof chunk === 'string'
              ? new TextEncoder().encode(chunk)
              : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        }
      },
    } as unknown as ServerResponse;

    await middleware!(req, res, () => {
      throw new Error(`Unexpected next() for ${reqUrl}`);
    });

    return { statusCode: res.statusCode, headers: resHeaders, body: Buffer.from(endedBody) };
  };
}

function countOpaquePixels(raster: {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}): {
  total: number;
  leftHalf: number;
  rightHalf: number;
  width: number;
} {
  let total = 0;
  let leftHalf = 0;
  let rightHalf = 0;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (raster.pixels[(y * raster.width + x) * 4 + 3] > 0) {
        total++;
        if (x < raster.width / 2) leftHalf++;
        else rightHalf++;
      }
    }
  }
  return { total, leftHalf, rightHalf, width: raster.width };
}

function pixelBuffersDiffer(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

describe('OSRS Cache Loading & Chathead Rendering Engine', () => {
  it('loads real OSRS rev 242 cache from ./cache when present, plus starter .dat2/.idx* cache', async () => {
    const built = buildStarterCache();
    const starterCache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.dat2Files.entries()),
      'memory-starter'
    );
    expect(starterCache.format).toBe('dat2');
    const hansStarter = await starterCache.getNpc(3106);
    expect(hansStarter?.name).toBe('Hans');
    const zulrahStarter = await starterCache.getNpc(2042);
    expect(zulrahStarter?.multiChildren).toEqual([2042, 2043, 2044]);

    const cacheDir = path.resolve(process.cwd(), 'cache');
    const diskCache = await OsrsUnifiedCache.open(new NodeFileMapProvider(cacheDir), 'disk-cache');
    expect(diskCache.format).toBe('dat2');
    const summary = await diskCache.getSummary();
    expect(summary.npcCount).toBeGreaterThanOrEqual(8);
    expect(summary.chatheadNpcCount).toBeGreaterThanOrEqual(8);
    expect(summary.itemCount).toBeGreaterThanOrEqual(8);
    expect(summary.kitCount).toBeGreaterThanOrEqual(6);
    expect(summary.seqCount).toBeGreaterThanOrEqual(6);

    // If full OSRS cache is present in ./cache, verify real rev 242 Kits, NPCs, and GameVal seq names
    if (summary.npcCount > 1000) {
      const hans = await diskCache.getNpc(3105);
      expect(hans?.name).toBe('Hans');
      expect(hans?.chatheadModels).toEqual([55]);

      const kits = await diskCache.getAllKits();
      const headKits = kits.filter((k) => k.bodyPartId === 0 && k.chatheadModels.some((m) => m >= 0));
      expect(headKits.length).toBeGreaterThan(20);

      const seq588 = await diskCache.getSeq(588);
      expect(seq588?.chatFrameIds.length).toBeGreaterThan(0);
      expect(seq588?.name).toBe('chatneu1');
    }
  });

  it('loads Abex .flatcache and plain .dat model caches uniformly', async () => {
    const built = buildStarterCache();

    const flatCache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.flatFiles.entries()),
      'memory-flatcache'
    );
    expect(flatCache.format).toBe('abex-flatcache');
    const wom = await flatCache.getNpc(2108);
    expect(wom?.name).toBe('Wise Old Man');

    const rawDatCache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.rawDatFiles.entries()),
      'memory-raw-dat'
    );
    expect(rawDatCache.format).toBe('raw-dat');
    const modelIds = await rawDatCache.getModelIds();
    expect(modelIds.length).toBeGreaterThan(5);
    const npcs = await rawDatCache.getAllNpcs();
    expect(npcs.length).toBe(modelIds.length);

    // Directory-based flatcache ({index}/{archive}/{file}.dat)
    const dirFlatMap = new MemoryFileMapProvider();
    for (const [mId, bytes] of built.rawDatFiles.entries()) {
      const numericId = mId.replace('.dat', '');
      dirFlatMap.set(`7/${numericId}/0.dat`, bytes);
    }
    const womNpc = await flatCache.getNpc(2108);
    expect(womNpc).toBeDefined();
    // Put raw NPC #3106 bytes from flatcache into 2/9/3106.dat
    const flatReaderCache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.dat2Files.entries()),
      'dat2-extract'
    );
    const allItems = await flatReaderCache.getAllItems();
    expect(allItems.length).toBeGreaterThanOrEqual(8);

    const dirFlatCache = await OsrsUnifiedCache.open(dirFlatMap, 'dir-flatcache');
    expect(dirFlatCache.format).toBe('dir-flatcache');
    expect((await dirFlatCache.getModelIds()).length).toBe(modelIds.length);
  });

  it('renders NPC chatheads facing right (yaw=1882) and Player chatheads facing left (yaw=166)', async () => {
    const built = buildStarterCache();
    const cache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.dat2Files.entries()),
      'memory-dat2'
    );

    const hans = await cache.getNpc(3106);
    expect(hans).toBeDefined();
    const npcResolved = await resolveNpcChathead(cache, hans!);
    expect(npcResolved).not.toBeNull();
    expect(npcResolved!.defaultCamera.rotationY).toBe(OSRS_NPC_CHATHEAD_CAMERA.rotationY);
    expect(npcResolved!.defaultCamera.modelZoom).toBe(796);

    const npcRaster = await renderAnimatedFrame(
      cache,
      npcResolved!.mesh,
      npcResolved!.defaultCamera,
      null,
      0
    );
    expect(npcRaster.width).toBeGreaterThanOrEqual(192);
    expect(npcRaster.height).toBeGreaterThanOrEqual(192);
    const npcStats = countOpaquePixels(npcRaster);
    expect(npcStats.total).toBeGreaterThan(500);

    // Player chathead faces left (yaw = 166)
    const playerResolved = await resolvePlayerChathead(cache, {
      gender: 'male',
      headKitId: 0,
      jawKitId: 11,
      helmItemId: 1042, // Blue partyhat
      skinHsl: 4550,
      hairHsl: 6798,
    });
    expect(playerResolved).not.toBeNull();
    expect(playerResolved!.defaultCamera.rotationY).toBe(OSRS_PLAYER_CHATHEAD_CAMERA.rotationY);
    expect(playerResolved!.defaultCamera.rotationY).toBe(166);

    const playerRaster = await renderAnimatedFrame(
      cache,
      playerResolved!.mesh,
      playerResolved!.defaultCamera,
      null,
      0
    );
    expect(playerRaster.width).toBeGreaterThanOrEqual(192);
    expect(playerRaster.height).toBeGreaterThanOrEqual(192);
    const playerStats = countOpaquePixels(playerRaster);
    expect(playerStats.total).toBeGreaterThan(500);

    // Render same player mesh with NPC right-facing camera to verify yaw actually rotates left vs right
    const mirroredRaster = await renderAnimatedFrame(
      cache,
      playerResolved!.mesh,
      OSRS_NPC_CHATHEAD_CAMERA,
      null,
      0
    );
    expect(pixelBuffersDiffer(playerRaster.pixels, mirroredRaster.pixels)).toBe(true);
  });

  it('hides hair and beard kits automatically when wearing a full helm (wearpos2=8, wearpos3=11)', async () => {
    const built = buildStarterCache();
    const cache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.dat2Files.entries()),
      'memory-dat2'
    );

    const withFullHelm = await resolvePlayerChathead(cache, {
      gender: 'male',
      headKitId: 0,
      jawKitId: 11,
      helmItemId: 1153, // Iron full helm
      skinHsl: 4550,
      hairHsl: 6798,
    });

    expect(withFullHelm).not.toBeNull();
    // Should contain only helm model 201 (not hair 100 or beard 111)
    expect(withFullHelm!.modelIds).toEqual([201]);
  });

  it('animates specific frames using both primary frameIds and opcode 12 chatFrameIds', async () => {
    const built = buildStarterCache();
    const cache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.dat2Files.entries()),
      'memory-dat2'
    );

    const hans = await cache.getNpc(3106);
    const resolved = await resolveNpcChathead(cache, hans!);
    const happySeq = await cache.getSeq(588);
    expect(happySeq).toBeDefined();
    expect(happySeq!.frameIds.length).toBeGreaterThan(1);
    expect(happySeq!.chatFrameIds.length).toBeGreaterThan(1);

    const frame0 = await renderAnimatedFrame(cache, resolved!.mesh, resolved!.defaultCamera, happySeq!, 0, 80, 2);
    const frame1 = await renderAnimatedFrame(cache, resolved!.mesh, resolved!.defaultCamera, happySeq!, 1, 80, 2);
    const frame2 = await renderAnimatedFrame(cache, resolved!.mesh, resolved!.defaultCamera, happySeq!, 2, 80, 2);

    expect(pixelBuffersDiffer(frame0.pixels, frame1.pixels)).toBe(true);
    expect(pixelBuffersDiffer(frame1.pixels, frame2.pixels)).toBe(true);
  });

  it('renders authentic 519x142 OSRS chatboxes, multi-turn strips, and animated GIFs', async () => {
    const built = buildStarterCache();
    const cache = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.dat2Files.entries()),
      'memory-dat2'
    );

    const hans = await cache.getNpc(3106);
    const resolved = await resolveNpcChathead(cache, hans!);
    const seq = await cache.getSeq(591);

    const frames = await renderSequenceFrames(cache, resolved!.mesh, resolved!.defaultCamera, seq!, 80, 1);
    expect(frames.length).toBe(4);

    // Transparent animated chathead GIF
    const chatheadGif = encodeAnimatedGif(frames, true);
    expect(String.fromCharCode(...chatheadGif.slice(0, 6))).toBe('GIF89a');
    expect(chatheadGif.length).toBeGreaterThan(500);

    // Chatbox PNG buffer (519x142)
    const npcBox = renderChatbox(frames[0].frame, {
      speakerName: 'Hans',
      dialogueText: 'Hello! <col=800000>Welcome</col> to Lumbridge Castle.',
      layout: 'npc-left',
      showPrompt: true,
      scale: 1,
    });
    expect(npcBox.width).toBe(CHATBOX_WIDTH);
    expect(npcBox.height).toBe(CHATBOX_HEIGHT);

    const playerBox = renderChatbox(frames[0].frame, {
      speakerName: 'Zezima',
      dialogueText: 'Can you tell me how long I have been here?',
      layout: 'player-right',
      showPrompt: true,
      scale: 1,
    });
    const strip = stackChatboxes([npcBox, playerBox], 4);
    expect(strip.width).toBe(CHATBOX_WIDTH);
    expect(strip.height).toBe(CHATBOX_HEIGHT * 2 + 4);

    // Animated Chatbox GIF
    const boxGif = encodeAnimatedGif(
      frames.map((f) => ({
        frame: renderChatbox(f.frame, {
          speakerName: 'Hans',
          dialogueText: 'Animated chathead inside chatbox!',
          layout: 'npc-left',
          showPrompt: true,
          scale: 1,
        }),
        delayMs: f.delayMs,
      })),
      false
    );
    expect(String.fromCharCode(...boxGif.slice(0, 6))).toBe('GIF89a');
  });

  it('serves cache status, NPCs, items, kits, seqs, models, and frames through the API middleware', async () => {
    let middleware:
      | ((req: any, res: any, next: () => void) => Promise<void> | void)
      | undefined;

    const plugin = osrsApiPlugin();
    (plugin.configureServer as (srv: any) => void)({
      middlewares: {
        use(fn: any) {
          middleware = fn;
        },
      },
    });
    expect(middleware).toBeDefined();

    const invokeApi = async (url: string, method = 'GET') => {
      let status = 200;
      let body = '';
      const req = {
        url,
        method,
        async *[Symbol.asyncIterator]() {},
      };
      const res = {
        set statusCode(code: number) {
          status = code;
        },
        get statusCode() {
          return status;
        },
        setHeader() {},
        end(chunk?: string) {
          body = chunk ?? '';
        },
      };
      await middleware!(req, res, () => {});
      return { status, json: JSON.parse(body) as any };
    };

    const statusRes = await invokeApi('/api/cache/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.json.loaded).toBe(true);
    expect(statusRes.json.summary.format).toBe('dat2');

    const npcRes = await invokeApi('/api/cache/npcs?q=Hans&onlyChathead=1');
    expect(npcRes.status).toBe(200);
    expect(npcRes.json.npcs.some((n: any) => n.name === 'Hans')).toBe(true);

    const itemsRes = await invokeApi('/api/cache/items?q=partyhat&onlyHeadgear=1');
    expect(itemsRes.status).toBe(200);
    expect(itemsRes.json.items.length).toBeGreaterThanOrEqual(4);

    const kitsRes = await invokeApi('/api/cache/kits');
    expect(kitsRes.status).toBe(200);
    expect(kitsRes.json.kits.length).toBeGreaterThanOrEqual(6);

    const seqsRes = await invokeApi('/api/cache/seqs');
    expect(seqsRes.status).toBe(200);
    expect(seqsRes.json.seqs.some((s: any) => s.seq.id === 588)).toBe(true);

    const hansNpc = npcRes.json.npcs.find((n: any) => n.name === 'Hans' && n.chatheadModels.length > 0);
    expect(hansNpc).toBeDefined();
    const modelRes = await invokeApi(`/api/cache/model/${hansNpc.chatheadModels[0]}`);
    expect(modelRes.status).toBe(200);
    expect(modelRes.json.vertexCount).toBeGreaterThan(20);
    expect(modelRes.json.faceCount).toBeGreaterThan(20);

    const seqRes = await invokeApi('/api/cache/seq/588');
    expect(seqRes.status).toBe(200);
    expect(seqRes.json.chatFrameIds.length).toBeGreaterThan(0);
    const fid = seqRes.json.frameIds[0];
    const frameRes = await invokeApi(`/api/cache/frame/${fid >>> 16}/${fid & 0xffff}`);
    expect(frameRes.status).toBe(200);
    expect(frameRes.json.framemapId).toBeGreaterThanOrEqual(0);
  });

  it('positions Zeke (#2875) and Farid Morrisane (#3115) inside the authentic 96x96 chatbox slot', async () => {
    const cacheDir = path.resolve(process.cwd(), 'cache');
    const diskCache = await OsrsUnifiedCache.open(new NodeFileMapProvider(cacheDir), 'disk-cache');
    const summary = await diskCache.getSummary();
    if (summary.npcCount < 1000) return;

    const blankBox = renderChatbox(null, {
      speakerName: '',
      dialogueText: '',
      layout: 'npc-left',
      showPrompt: false,
      scale: 1,
    });

    const measureHeadBoundsInChatbox = (boxPixels: Uint8ClampedArray) => {
      let minX = CHATBOX_WIDTH;
      let maxX = -1;
      let minY = CHATBOX_HEIGHT;
      let maxY = -1;
      for (let y = 0; y < CHATBOX_HEIGHT; y++) {
        for (let x = 0; x < CHATBOX_WIDTH; x++) {
          const i = (y * CHATBOX_WIDTH + x) * 4;
          if (
            boxPixels[i] !== blankBox.pixels[i] ||
            boxPixels[i + 1] !== blankBox.pixels[i + 1] ||
            boxPixels[i + 2] !== blankBox.pixels[i + 2]
          ) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { minX, maxX, minY, maxY };
    };

    const zeke = await diskCache.getNpc(2875);
    expect(zeke).toBeDefined();
    const zekeResolved = await resolveNpcChathead(diskCache, zeke!);
    const seq614 = await diskCache.getSeq(614);
    const zekePair = await renderAnimatedFramePair(diskCache, zekeResolved!.mesh, zekeResolved!.defaultCamera, seq614, 6);
    expect(zekePair.regular.width).toBe(192);
    expect(zekePair.regular.height).toBe(192);
    expect(zekePair.hasSubstantialDifference).toBe(true);
    expect(zekePair.full.height).toBeGreaterThan(250);
    const zekeFullBounds = measureOpaqueBounds(zekePair.full);
    expect(zekeFullBounds?.minY).toBe(0);
    expect(zekeFullBounds?.maxY).toBe(zekePair.full.height - 1);
    const zekeBox = renderChatbox(zekePair.regular, {
      speakerName: '',
      dialogueText: '',
      layout: 'npc-left',
      showPrompt: false,
      scale: 1,
    });
    expect(measureHeadBoundsInChatbox(zekeBox.pixels)).toEqual({
      minX: 35,
      maxX: 103,
      minY: 23,
      maxY: 118,
    });

    const farid = await diskCache.getNpc(3115);
    expect(farid).toBeDefined();
    const faridResolved = await resolveNpcChathead(diskCache, farid!);
    const seq610 = await diskCache.getSeq(610);
    const faridPair = await renderAnimatedFramePair(diskCache, faridResolved!.mesh, faridResolved!.defaultCamera, seq610, 4);
    expect(faridPair.regular.width).toBe(192);
    expect(faridPair.regular.height).toBe(192);
    expect(faridPair.hasSubstantialDifference).toBe(false);
    const faridBox = renderChatbox(faridPair.regular, {
      speakerName: '',
      dialogueText: '',
      layout: 'npc-left',
      showPrompt: false,
      scale: 1,
    });
    expect(measureHeadBoundsInChatbox(faridBox.pixels)).toEqual({
      minX: 45,
      maxX: 94,
      minY: 32,
      maxY: 110,
    });

    // Odd Old Man (#16895): full render crops tightly to exact bottom of beard (0 excess rows), regular is 192x192, chatbox stays 23..118
    const oddOldMan = await diskCache.getNpc(16895);
    expect(oddOldMan).toBeDefined();
    const oddResolved = await resolveNpcChathead(diskCache, oddOldMan!);
    const seq588 = await diskCache.getSeq(588);
    const oddPair = await renderAnimatedFramePair(diskCache, oddResolved!.mesh, oddResolved!.defaultCamera, seq588, 0);
    expect(oddPair.regular.width).toBe(192);
    expect(oddPair.regular.height).toBe(192);
    expect(oddPair.hasSubstantialDifference).toBe(true);
    expect(oddPair.full.height).toBeGreaterThan(500);
    const oddFullBounds = measureOpaqueBounds(oddPair.full);
    expect(oddFullBounds?.minX).toBe(0);
    expect(oddFullBounds?.maxX).toBe(oddPair.full.width - 1);
    expect(oddFullBounds?.minY).toBe(0);
    expect(oddFullBounds?.maxY).toBe(oddPair.full.height - 1);
    const oddBox = renderChatbox(oddPair.regular, {
      speakerName: '',
      dialogueText: '',
      layout: 'npc-left',
      showPrompt: false,
      scale: 1,
    });
    const oddBoxBounds = measureHeadBoundsInChatbox(oddBox.pixels);
    expect(oddBoxBounds.minY).toBeGreaterThanOrEqual(23);
    expect(oddBoxBounds.maxY).toBeLessThanOrEqual(118);

    // Animated full-sequence crop & envelope clamping keeps identical upper-limit dimensions across frames
    const unionBounds = await computeSequenceUnionBounds(diskCache, oddResolved!.mesh, oddResolved!.defaultCamera, seq588!, 96, 2);
    expect(unionBounds).not.toBeNull();
    const lockedF0 = await renderAnimatedFramePair(diskCache, oddResolved!.mesh, oddResolved!.defaultCamera, seq588, 0, 96, 2, unionBounds);
    const lockedF4 = await renderAnimatedFramePair(diskCache, oddResolved!.mesh, oddResolved!.defaultCamera, seq588, 4, 96, 2, unionBounds);
    const lockedF8 = await renderAnimatedFramePair(diskCache, oddResolved!.mesh, oddResolved!.defaultCamera, seq588, 8, 96, 2, unionBounds);
    expect(lockedF0.full.width).toBe(lockedF4.full.width);
    expect(lockedF0.full.height).toBe(lockedF4.full.height);
    expect(lockedF0.full.width).toBe(lockedF8.full.width);
    expect(lockedF0.full.height).toBe(lockedF8.full.height);

    // Individual frozen frames crop tightly to that frame's exact opaque pixels (no union enlargement)
    const tightF8 = await renderAnimatedFramePair(diskCache, oddResolved!.mesh, oddResolved!.defaultCamera, seq588, 8, 96, 2, null);
    const tightF8Bounds = measureOpaqueBounds(tightF8.full);
    expect(tightF8Bounds?.minY).toBe(0);
    expect(tightF8Bounds?.maxY).toBe(tightF8.full.height - 1);
    expect(tightF8.full.height).toBeLessThanOrEqual(lockedF0.full.height);

    const oddFullSeq = await renderSequenceFrames(diskCache, oddResolved!.mesh, oddResolved!.defaultCamera, seq588!, 96, 2, true);
    const seqW = oddFullSeq[0].frame.width;
    const seqH = oddFullSeq[0].frame.height;
    expect(seqW).toBe(lockedF0.full.width);
    expect(seqH).toBe(lockedF0.full.height);
    expect(oddFullSeq.every((f) => f.frame.width === seqW && f.frame.height === seqH)).toBe(true);
  });

  it('uses authentic OSRS q8_full metrics for dialogue measurement and wrapping', () => {
    expect(measureBitmapText('Zeke', FONT_QUILL_8)).toBe(31);
    expect(measureBitmapText('Click here to continue', FONT_QUILL_8)).toBe(147);
    expect(
      wrapBitmapText(
        "I would prefer it if you didn't speak to me in such a manner. I'll have you know I'm an accomplished merchant.",
        FONT_QUILL_8,
        380
      )
    ).toEqual([
      "I would prefer it if you didn't speak to me in such a",
      "manner. I'll have you know I'm an accomplished",
      'merchant.',
    ]);
  });

  it('enforces API security: blocks path traversal, cross-origin POSTs, bad Content-Type, and invalid route params', async () => {
    const invokeMiddleware = createApiMiddlewareInvoker();

    const statusRes = await invokeMiddleware('GET', '/api/cache/status');
    expect(statusRes.statusCode).toBe(200);
    const statusJson = JSON.parse(statusRes.body.toString('utf8')) as {
      activePath: string;
      candidateDirs: string[];
    };
    expect(statusJson.activePath).toBe('./cache');
    expect(statusJson.activePath).not.toContain('/home/');
    for (const dir of statusJson.candidateDirs) {
      expect(dir).not.toContain('/home/');
    }

    const etcRes = await invokeMiddleware(
      'POST',
      '/api/cache/load-path',
      { 'content-type': 'application/json' },
      JSON.stringify({ dirPath: '/etc' })
    );
    expect(etcRes.statusCode).toBe(403);

    const relRes = await invokeMiddleware(
      'POST',
      '/api/cache/load-path',
      { 'content-type': 'application/json' },
      JSON.stringify({ dirPath: '../../etc' })
    );
    expect(relRes.statusCode).toBe(403);

    const crossSiteRes = await invokeMiddleware(
      'POST',
      '/api/cache/load-path',
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      JSON.stringify({ dirPath: './cache' })
    );
    expect(crossSiteRes.statusCode).toBe(403);

    const wrongCtRes = await invokeMiddleware(
      'POST',
      '/api/cache/load-path',
      { 'content-type': 'text/plain' },
      '{}'
    );
    expect(wrongCtRes.statusCode).toBe(415);

    const badNpcRes = await invokeMiddleware('GET', '/api/cache/npc/abc');
    expect(badNpcRes.statusCode).toBe(400);

    const badModelRes = await invokeMiddleware('GET', '/api/cache/model/-1');
    expect(badModelRes.statusCode).toBe(400);

    const badEncodingRes = await invokeMiddleware('GET', '/api/player/lookup/%E0%A4%A');
    expect(badEncodingRes.statusCode).toBe(400);

    // Sibling prefix escape attempt must fail containment check
    const provider = new NodeFileMapProvider(path.resolve(process.cwd(), 'cache'));
    await expect(provider.getFile('../cache-other/secret')).resolves.toBeUndefined();
  });

  it('provides Open Graph / Twitter Card metadata, valid 1200x630 preview PNG, and safe absolute origin rewriting', async () => {
    const ogPngPath = path.resolve(process.cwd(), 'public', 'og-image.png');
    const pngBytes = await fs.readFile(ogPngPath);
    expect(Array.from(pngBytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrView = new DataView(pngBytes.buffer, pngBytes.byteOffset + 16, 8);
    expect(ihdrView.getUint32(0, false)).toBe(1200);
    expect(ihdrView.getUint32(4, false)).toBe(630);

    const indexHtml = await fs.readFile(path.resolve(process.cwd(), 'index.html'), 'utf8');
    for (const marker of [
      'property="og:type"',
      'property="og:title"',
      'property="og:description"',
      'property="og:image"',
      'property="og:image:width"',
      'property="og:image:height"',
      'name="twitter:card"',
      'name="twitter:title"',
      'name="twitter:description"',
      'name="twitter:image"',
    ]) {
      expect(indexHtml).toContain(marker);
    }

    expect(
      resolvePublicOrigin(
        { host: 'internal:5173', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'ignored.example' },
        { publicUrl: 'https://chathead.example.com/app/', trustProxy: false }
      )
    ).toBe('https://chathead.example.com');

    expect(
      resolvePublicOrigin(
        { host: 'internal:5173', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'proxy.example.com' },
        { publicUrl: '', trustProxy: true }
      )
    ).toBe('https://proxy.example.com');

    expect(
      resolvePublicOrigin(
        { host: 'direct.example.com:5173', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'spoofed.example.com' },
        { publicUrl: '', trustProxy: false }
      )
    ).toBe('http://direct.example.com:5173');

    expect(
      resolvePublicOrigin(
        { host: 'evil.com"><script>' },
        { publicUrl: '', trustProxy: false }
      )
    ).toBeNull();

    const rewritten = applySocialMetaUrls(indexHtml, 'https://osrs.example.com');
    expect(rewritten).toContain('<meta property="og:image" content="https://osrs.example.com/og-image.png" />');
    expect(rewritten).toContain('<meta name="twitter:image" content="https://osrs.example.com/og-image.png" />');
    expect(rewritten).toContain('<meta property="og:url" content="https://osrs.example.com/" />');
    expect(rewritten).toContain('<link rel="canonical" href="https://osrs.example.com/" />');
  });
});
