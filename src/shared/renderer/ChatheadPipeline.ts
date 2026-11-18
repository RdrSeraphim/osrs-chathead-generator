import { ItemDef, KitDef, NpcDef, SeqDef, UnifiedCache } from '../cache/types';
import { CHATHEAD_PRESET_MAP } from '../constants/chatheadAnims';
import {
  DEFAULT_HAIR_SOURCE_HSL,
  DEFAULT_SKIN_SOURCE_HSL,
} from '../constants/playerColors';
import {
  animateMesh,
  ColorOverride,
  extractPaletteFromMesh,
  LitMesh,
  mergeAndLightModels,
  SubModelInput,
} from './ModelMesh';
import {
  CameraParams,
  computeAutoFitCamera,
  cropRasterToOpaqueBounds,
  cropRasterToRect,
  measureOpaqueBounds,
  OSRS_NPC_CHATHEAD_CAMERA,
  OSRS_PLAYER_CHATHEAD_CAMERA,
  RasterOutput,
  renderChathead,
} from './SoftwareRasterizer';

export interface ResolvedChathead {
  mesh: LitMesh;
  defaultCamera: CameraParams;
  usedFallbackModels: boolean;
  palette: Array<{ hsl: number; count: number }>;
  modelIds: number[];
}

export interface PlayerCompositionConfig {
  gender: 'male' | 'female';
  headKitId: number | null;
  jawKitId: number | null;
  helmItemId: number | null;
  skinHsl: number;
  hairHsl: number;
  extraColors?: ColorOverride[];
}

export async function resolveNpcChathead(
  cache: UnifiedCache,
  npc: NpcDef,
  extraColors: ColorOverride[] = []
): Promise<ResolvedChathead | null> {
  let activeNpc = npc;
  let modelIds = activeNpc.chatheadModels.filter((id) => id >= 0 && id !== 65535);
  let usedFallbackModels = false;

  if (modelIds.length === 0 && (activeNpc.multiChildren.length > 0 || activeNpc.oobChild >= 0)) {
    const childIds = [
      ...activeNpc.multiChildren,
      ...(activeNpc.oobChild >= 0 ? [activeNpc.oobChild] : []),
    ];
    for (const childId of childIds) {
      if (childId < 0) continue;
      const child = await cache.getNpc(childId);
      if (child && child.chatheadModels.length > 0) {
        activeNpc = child;
        modelIds = child.chatheadModels.filter((id) => id >= 0 && id !== 65535);
        break;
      }
    }
  }

  if (modelIds.length === 0 && activeNpc.models.length > 0) {
    modelIds = activeNpc.models.filter((id) => id >= 0 && id !== 65535);
    usedFallbackModels = true;
  }

  if (modelIds.length === 0) return null;

  const inputs: SubModelInput[] = [];
  for (const mId of modelIds) {
    const model = await cache.getModel(mId);
    if (model) {
      inputs.push({
        model,
        recolorFrom: activeNpc.recolorFrom,
        recolorTo: activeNpc.recolorTo,
        retextureFrom: activeNpc.retextureFrom,
        retextureTo: activeNpc.retextureTo,
      });
    }
  }

  if (inputs.length === 0) return null;

  const mesh = mergeAndLightModels(
    inputs,
    extraColors,
    activeNpc.ambient ?? 0,
    activeNpc.contrast ?? 0
  );

  const defaultCamera = usedFallbackModels
    ? computeAutoFitCamera(mesh, true)
    : { ...OSRS_NPC_CHATHEAD_CAMERA };

  return {
    mesh,
    defaultCamera,
    usedFallbackModels,
    palette: extractPaletteFromMesh(mesh),
    modelIds,
  };
}

export async function resolvePlayerChathead(
  cache: UnifiedCache,
  config: PlayerCompositionConfig
): Promise<ResolvedChathead | null> {
  const inputs: SubModelInput[] = [];
  const modelIds: number[] = [];

  let helm: ItemDef | undefined;
  if (config.helmItemId !== null && config.helmItemId >= 0) {
    helm = await cache.getItem(config.helmItemId);
  }

  const hidesHair =
    helm !== undefined &&
    (helm.wearpos2 === 8 || helm.wearpos3 === 8);
  const hidesJaw =
    helm !== undefined &&
    (helm.wearpos2 === 11 || helm.wearpos3 === 11);

  const pushKit = async (kitId: number | null) => {
    if (kitId === null || kitId < 0) return;
    const kit = await cache.getKit(kitId);
    if (!kit) return;
    const kitModelIds = kit.chatheadModels.filter((id) => id >= 0 && id !== 65535);
    for (const mId of kitModelIds) {
      const m = await cache.getModel(mId);
      if (m) {
        modelIds.push(mId);
        inputs.push({
          model: m,
          recolorFrom: [
            ...(kit.recolorFrom ?? []),
            DEFAULT_SKIN_SOURCE_HSL,
            DEFAULT_HAIR_SOURCE_HSL,
          ],
          recolorTo: [
            ...(kit.recolorTo ?? []),
            config.skinHsl,
            config.hairHsl,
          ],
        });
      }
    }
  };

  if (!hidesHair) {
    await pushKit(config.headKitId);
  }
  if (!hidesJaw && config.gender === 'male') {
    await pushKit(config.jawKitId);
  }

  if (helm) {
    const primary =
      config.gender === 'male' ? helm.maleChatheadModel : helm.femaleChatheadModel;
    const secondary =
      config.gender === 'male' ? helm.maleChatheadModel1 : helm.femaleChatheadModel1;
    const helmIds = [primary, secondary].filter((id) => id >= 0 && id !== 65535);
    for (const mId of helmIds) {
      const m = await cache.getModel(mId);
      if (m) {
        modelIds.push(mId);
        inputs.push({
          model: m,
          recolorFrom: helm.recolorFrom,
          recolorTo: helm.recolorTo,
          retextureFrom: helm.retextureFrom,
          retextureTo: helm.retextureTo,
        });
      }
    }
  }

  if (inputs.length === 0) return null;

  const mesh = mergeAndLightModels(inputs, config.extraColors ?? []);
  return {
    mesh,
    defaultCamera: { ...OSRS_PLAYER_CHATHEAD_CAMERA },
    usedFallbackModels: false,
    palette: extractPaletteFromMesh(mesh),
    modelIds,
  };
}

export interface CompatibleSeqEntry {
  seq: SeqDef;
  label: string;
  hasChatFrames: boolean;
  frameCount: number;
}

/**
 * Find chathead animations in the cache (all presets + sequences with chatFrameIds or compatible bone skeletons).
 */
export async function findChatheadSequences(
  cache: UnifiedCache,
  _mesh?: LitMesh
): Promise<CompatibleSeqEntry[]> {
  const allSeqs = await cache.getAllSeqs();
  const results: CompatibleSeqEntry[] = [];

  for (const seq of allSeqs) {
    if (seq.frameIds.length === 0 && seq.chatFrameIds.length === 0) continue;

    const preset = CHATHEAD_PRESET_MAP.get(seq.id);
    const hasChatFrames = seq.chatFrameIds.length > 0;
    const isChatPreset = preset !== undefined;
    const lowerName = seq.name?.toLowerCase() ?? '';
    const isChatNamed =
      lowerName.includes('chat') ||
      lowerName.includes('talk') ||
      lowerName.includes('head');

    if (!hasChatFrames && !isChatPreset && !isChatNamed) {
      continue;
    }

    const frameCount = Math.max(seq.frameIds.length, seq.chatFrameIds.length);
    const label = preset
      ? `${preset.label} (#${seq.id})`
      : seq.name
        ? `${seq.name} (#${seq.id})`
        : `Sequence #${seq.id}${hasChatFrames ? ' [Chat]' : ''}`;

    results.push({
      seq,
      label,
      hasChatFrames,
      frameCount,
    });
  }

  // Sort presets first, then by ID
  results.sort((a, b) => {
    const aPre = CHATHEAD_PRESET_MAP.has(a.seq.id) ? 0 : 1;
    const bPre = CHATHEAD_PRESET_MAP.has(b.seq.id) ? 0 : 1;
    if (aPre !== bPre) return aPre - bPre;
    if (a.hasChatFrames !== b.hasChatFrames) return a.hasChatFrames ? -1 : 1;
    return a.seq.id - b.seq.id;
  });

  return results;
}

function getFramePairIdsForStep(
  seq: SeqDef,
  frameIndex: number
): { primaryId: number; chatId: number } {
  if (seq.frameIds.length > 0) {
    const idx = frameIndex % seq.frameIds.length;
    return {
      primaryId: seq.frameIds[idx],
      chatId: idx < seq.chatFrameIds.length ? seq.chatFrameIds[idx] : -1,
    };
  }
  if (seq.chatFrameIds.length > 0) {
    const idx = frameIndex % seq.chatFrameIds.length;
    return {
      primaryId: -1,
      chatId: seq.chatFrameIds[idx],
    };
  }
  return { primaryId: -1, chatId: -1 };
}

async function prefetchSequenceFrames(cache: UnifiedCache, seq: SeqDef): Promise<void> {
  const count = Math.max(1, seq.frameIds.length, seq.chatFrameIds.length);
  const frameIds = new Set<number>();
  for (let i = 0; i < count; i++) {
    const { primaryId, chatId } = getFramePairIdsForStep(seq, i);
    if (primaryId >= 0 && (primaryId & 0xffff) !== 0xffff) frameIds.add(primaryId);
    if (chatId >= 0 && (chatId & 0xffff) !== 0xffff) frameIds.add(chatId);
  }
  await Promise.all(
    Array.from(frameIds, (id) => cache.getFrame(id >>> 16, id & 0xffff))
  );
}

async function resolveAnimatedVertices(
  cache: UnifiedCache,
  mesh: LitMesh,
  seq?: SeqDef | null,
  frameIndex = 0
) {
  if (!seq || (seq.frameIds.length === 0 && seq.chatFrameIds.length === 0)) {
    return animateMesh(mesh);
  }

  const { primaryId, chatId } = getFramePairIdsForStep(seq, frameIndex);

  let primaryFrame;
  if (primaryId >= 0 && (primaryId & 0xffff) !== 0xffff) {
    primaryFrame = await cache.getFrame(primaryId >>> 16, primaryId & 0xffff);
  }

  let chatFrame;
  if (chatId >= 0 && (chatId & 0xffff) !== 0xffff) {
    chatFrame = await cache.getFrame(chatId >>> 16, chatId & 0xffff);
  }

  return animateMesh(mesh, primaryFrame, chatFrame);
}

export async function renderAnimatedFrame(
  cache: UnifiedCache,
  mesh: LitMesh,
  camera: CameraParams,
  seq?: SeqDef | null,
  frameIndex = 0,
  baseSize = 96,
  scale = 2,
  fullUncropped = false
): Promise<RasterOutput> {
  const animated = await resolveAnimatedVertices(cache, mesh, seq, frameIndex);
  const raster = renderChathead(
    mesh,
    animated,
    camera,
    baseSize,
    baseSize,
    scale,
    fullUncropped
  );
  return fullUncropped ? cropRasterToOpaqueBounds(raster) : raster;
}

export interface RelativeBounds {
  minRelX: number;
  maxRelX: number;
  minRelY: number;
  maxRelY: number;
}

export interface RenderedChatheadPair {
  regular: RasterOutput;
  full: RasterOutput;
  hasSubstantialDifference: boolean;
}

export async function computeSequenceUnionBounds(
  cache: UnifiedCache,
  mesh: LitMesh,
  camera: CameraParams,
  seq: SeqDef,
  baseSize = 96,
  scale = 2
): Promise<RelativeBounds | null> {
  await prefetchSequenceFrames(cache, seq);
  const count = Math.max(1, seq.frameIds.length, seq.chatFrameIds.length);
  const seenPoses = new Set<string>();
  let minRelX = Infinity;
  let maxRelX = -Infinity;
  let minRelY = Infinity;
  let maxRelY = -Infinity;

  for (let i = 0; i < count; i++) {
    const { primaryId, chatId } = getFramePairIdsForStep(seq, i);
    const poseKey = `${primaryId}:${chatId}`;
    if (seenPoses.has(poseKey)) continue;
    seenPoses.add(poseKey);

    const animated = await resolveAnimatedVertices(cache, mesh, seq, i);
    const raw = renderChathead(mesh, animated, camera, baseSize, baseSize, scale, true);
    const bounds = measureOpaqueBounds(raw);
    if (!bounds) continue;

    const ox = Math.round(raw.originX ?? 0);
    const oy = Math.round(raw.originY ?? 0);
    if (bounds.minX - ox < minRelX) minRelX = bounds.minX - ox;
    if (bounds.maxX - ox > maxRelX) maxRelX = bounds.maxX - ox;
    if (bounds.minY - oy < minRelY) minRelY = bounds.minY - oy;
    if (bounds.maxY - oy > maxRelY) maxRelY = bounds.maxY - oy;
  }

  if (maxRelX < minRelX || maxRelY < minRelY) return null;
  return { minRelX, maxRelX, minRelY, maxRelY };
}

export async function renderAnimatedFramePair(
  cache: UnifiedCache,
  mesh: LitMesh,
  camera: CameraParams,
  seq?: SeqDef | null,
  frameIndex = 0,
  baseSize = 96,
  scale = 2,
  unionBounds?: RelativeBounds | null
): Promise<RenderedChatheadPair> {
  const animated = await resolveAnimatedVertices(cache, mesh, seq, frameIndex);
  const regular = renderChathead(mesh, animated, camera, baseSize, baseSize, scale, false);
  const rawFull = renderChathead(mesh, animated, camera, baseSize, baseSize, scale, true);

  const ox = Math.round(rawFull.originX ?? 0);
  const oy = Math.round(rawFull.originY ?? 0);
  const targetRect = unionBounds
    ? {
        minX: ox + unionBounds.minRelX,
        maxX: ox + unionBounds.maxRelX,
        minY: oy + unionBounds.minRelY,
        maxY: oy + unionBounds.maxRelY,
      }
    : measureOpaqueBounds(rawFull);

  let hasSubstantialDifference = false;
  if (targetRect) {
    const regOriginX = regular.originX ?? regular.width / 2;
    const regOriginY = regular.originY ?? regular.height / 2;
    const regLeft = (rawFull.originX ?? regOriginX) - regOriginX;
    const regTop = (rawFull.originY ?? regOriginY) - regOriginY;
    const regRight = regLeft + regular.width - 1;
    const regBottom = regTop + regular.height - 1;
    const tol = 2 * scale;
    hasSubstantialDifference =
      targetRect.minX < regLeft - tol ||
      targetRect.maxX > regRight + tol ||
      targetRect.minY < regTop - tol ||
      targetRect.maxY > regBottom + tol;
  }

  const full = targetRect ? cropRasterToRect(rawFull, targetRect) : rawFull;
  return { regular, full, hasSubstantialDifference };
}

export async function renderSequenceFrames(
  cache: UnifiedCache,
  mesh: LitMesh,
  camera: CameraParams,
  seq: SeqDef,
  baseSize = 96,
  scale = 2,
  fullUncropped = false
): Promise<Array<{ frame: RasterOutput; delayMs: number }>> {
  await prefetchSequenceFrames(cache, seq);
  const count = Math.max(1, seq.frameIds.length, seq.chatFrameIds.length);
  const unionBounds = fullUncropped
    ? await computeSequenceUnionBounds(cache, mesh, camera, seq, baseSize, scale)
    : null;

  const poseCache = new Map<string, RasterOutput>();
  const out: Array<{ frame: RasterOutput; delayMs: number }> = [];

  for (let i = 0; i < count; i++) {
    const { primaryId, chatId } = getFramePairIdsForStep(seq, i);
    const poseKey = `${primaryId}:${chatId}`;

    let frame = poseCache.get(poseKey);
    if (!frame) {
      const animated = await resolveAnimatedVertices(cache, mesh, seq, i);
      const raw = renderChathead(
        mesh,
        animated,
        camera,
        baseSize,
        baseSize,
        scale,
        fullUncropped
      );
      if (fullUncropped && unionBounds) {
        const ox = Math.round(raw.originX ?? 0);
        const oy = Math.round(raw.originY ?? 0);
        frame = cropRasterToRect(raw, {
          minX: ox + unionBounds.minRelX,
          maxX: ox + unionBounds.maxRelX,
          minY: oy + unionBounds.minRelY,
          maxY: oy + unionBounds.maxRelY,
        });
      } else {
        frame = raw;
      }
      poseCache.set(poseKey, frame);
    }

    const ticks = seq.frameLengths[i % Math.max(1, seq.frameLengths.length)] ?? 4;
    const delayMs = Math.max(20, ticks * 20);
    out.push({ frame, delayMs });
  }

  return out;
}

export function getKitDisplayName(kit: KitDef): string {
  switch (kit.bodyPartId) {
    case 0:
      return `Male Hair/Head #${kit.id}`;
    case 1:
      return `Male Beard/Jaw #${kit.id}`;
    case 7:
      return `Female Hair/Head #${kit.id}`;
    case 8:
      return `Female Jaw #${kit.id}`;
    default:
      return `Kit #${kit.id} (part ${kit.bodyPartId})`;
  }
}
