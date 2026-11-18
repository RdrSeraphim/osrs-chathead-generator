import { ItemDef, KitDef, ModelDef, NpcDef, SeqDef, UnifiedCache } from '../cache/types';
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

  if (modelIds.length === 0 && activeNpc.multiChildren.length > 0) {
    for (const childId of activeNpc.multiChildren) {
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

export async function renderAnimatedFrame(
  cache: UnifiedCache,
  mesh: LitMesh,
  camera: CameraParams,
  seq?: SeqDef | null,
  frameIndex = 0,
  baseSize = 96,
  scale = 2
): Promise<RasterOutput> {
  if (!seq || (seq.frameIds.length === 0 && seq.chatFrameIds.length === 0)) {
    const staticVerts = animateMesh(mesh);
    return renderChathead(mesh, staticVerts, camera, baseSize, baseSize, scale);
  }

  let primaryFrame;
  if (seq.frameIds.length > 0) {
    const idx = frameIndex % seq.frameIds.length;
    const fid = seq.frameIds[idx];
    if (fid >= 0 && (fid & 0xffff) !== 0xffff) {
      primaryFrame = await cache.getFrame(fid >>> 16, fid & 0xffff);
    }
  }

  let chatFrame;
  if (seq.chatFrameIds.length > 0) {
    const idx = frameIndex % seq.chatFrameIds.length;
    const cfid = seq.chatFrameIds[idx];
    if (cfid >= 0 && (cfid & 0xffff) !== 0xffff) {
      chatFrame = await cache.getFrame(cfid >>> 16, cfid & 0xffff);
    }
  }

  const animated = animateMesh(mesh, primaryFrame, chatFrame);
  return renderChathead(mesh, animated, camera, baseSize, baseSize, scale);
}

export async function renderSequenceFrames(
  cache: UnifiedCache,
  mesh: LitMesh,
  camera: CameraParams,
  seq: SeqDef,
  baseSize = 96,
  scale = 2
): Promise<Array<{ frame: RasterOutput; delayMs: number }>> {
  const count = Math.max(1, seq.frameIds.length, seq.chatFrameIds.length);
  const out: Array<{ frame: RasterOutput; delayMs: number }> = [];

  for (let i = 0; i < count; i++) {
    const raster = await renderAnimatedFrame(cache, mesh, camera, seq, i, baseSize, scale);
    const ticks = seq.frameLengths[i % Math.max(1, seq.frameLengths.length)] ?? 4;
    const delayMs = Math.max(20, ticks * 20);
    out.push({ frame: raster, delayMs });
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
