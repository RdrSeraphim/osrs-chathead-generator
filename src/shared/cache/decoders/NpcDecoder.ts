import { CacheVersion, NPCID, Reader, NPC as Cache2NPC } from '@abextm/cache2';
import { ByteBuffer } from '../ByteBuffer';
import { NpcDef } from '../types';

export function decodeNpc(
  data: Uint8Array,
  id: number,
  version?: CacheVersion,
  is317 = false
): NpcDef {
  if (!is317) {
    try {
      const r = new Reader(data, version);
      const npc = Cache2NPC.decode(r, id as NPCID);
      return {
        id: npc.id,
        name: npc.name || 'null',
        models: npc.models ?? [],
        chatheadModels: npc.chatheadModels ?? [],
        recolorFrom: npc.recolorFrom ?? [],
        recolorTo: npc.recolorTo ?? [],
        retextureFrom: npc.retextureFrom ?? [],
        retextureTo: npc.retextureTo ?? [],
        standingAnimation: npc.standingAnimation ?? -1,
        walkingAnimation: npc.walkingAnimation ?? -1,
        combatLevel: npc.combatLevel ?? -1,
        widthScale: npc.widthScale ?? 128,
        heightScale: npc.heightScale ?? 128,
        ambient: npc.ambient ?? 0,
        contrast: npc.contrast ?? 0,
        varbit: npc.varbit ?? -1,
        varp: npc.varp ?? -1,
        multiChildren: npc.multiChildren ?? [],
        oobChild: npc.oobChild ?? -1,
      };
    } catch {
      // Fall back to permissive decoder below for non-standard / older revisions
    }
  }

  return decodeNpcPermissive(data, id, is317);
}

function decodeNpcPermissive(data: Uint8Array, id: number, is317: boolean): NpcDef {
  const buf = new ByteBuffer(data);
  const def: NpcDef = {
    id,
    name: 'null',
    models: [],
    chatheadModels: [],
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
  };

  while (buf.remaining > 0) {
    const opcode = buf.u8();
    if (opcode === 0) break;
    if (opcode === 1) {
      const len = buf.u8();
      def.models = new Array(len);
      for (let i = 0; i < len; i++) def.models[i] = buf.u16();
    } else if (opcode === 2) {
      def.name = is317 ? buf.string317() : buf.string();
    } else if (opcode === 3) {
      is317 ? buf.string317() : buf.string();
    } else if (opcode === 12) {
      buf.u8();
    } else if (opcode === 13) {
      def.standingAnimation = buf.u16();
    } else if (opcode === 14) {
      def.walkingAnimation = buf.u16();
    } else if (opcode === 15 || opcode === 16 || opcode === 18) {
      buf.u16();
    } else if (opcode === 17) {
      def.walkingAnimation = buf.u16();
      buf.u16();
      buf.u16();
      buf.u16();
    } else if (opcode >= 30 && opcode < 40) {
      is317 ? buf.string317() : buf.string();
    } else if (opcode === 40) {
      const len = buf.u8();
      def.recolorFrom = new Array(len);
      def.recolorTo = new Array(len);
      for (let i = 0; i < len; i++) {
        def.recolorFrom[i] = buf.u16();
        def.recolorTo[i] = buf.u16();
      }
    } else if (opcode === 41) {
      const len = buf.u8();
      def.retextureFrom = new Array(len);
      def.retextureTo = new Array(len);
      for (let i = 0; i < len; i++) {
        def.retextureFrom[i] = buf.u16();
        def.retextureTo[i] = buf.u16();
      }
    } else if (opcode === 42) {
      buf.u16();
    } else if (opcode === 60) {
      const len = buf.u8();
      def.chatheadModels = new Array(len);
      for (let i = 0; i < len; i++) def.chatheadModels[i] = buf.u16();
    } else if (opcode === 61) {
      const len = buf.u8();
      def.models = new Array(len);
      for (let i = 0; i < len; i++) def.models[i] = buf.modelId();
    } else if (opcode === 62) {
      const len = buf.u8();
      def.chatheadModels = new Array(len);
      for (let i = 0; i < len; i++) def.chatheadModels[i] = buf.modelId();
    } else if (opcode >= 74 && opcode <= 79) {
      buf.u16();
    } else if (opcode === 90 || opcode === 91 || opcode === 92 || opcode === 94) {
      buf.u16();
    } else if (opcode === 93) {
      // minimap hidden
    } else if (opcode === 95) {
      def.combatLevel = buf.u16();
    } else if (opcode === 97) {
      def.widthScale = buf.u16();
    } else if (opcode === 98) {
      def.heightScale = buf.u16();
    } else if (opcode === 99) {
      // visible
    } else if (opcode === 100) {
      def.ambient = buf.i8();
    } else if (opcode === 101) {
      def.contrast = buf.i8();
    } else if (opcode === 102) {
      buf.u16();
    } else if (opcode === 103) {
      buf.u16();
    } else if (opcode === 106) {
      def.varbit = buf.u16n();
      def.varp = buf.u16n();
      const len = buf.u8();
      def.multiChildren = new Array(len + 1);
      for (let i = 0; i <= len; i++) def.multiChildren[i] = buf.u16n();
    } else if (opcode === 118) {
      def.varbit = buf.u16n();
      def.varp = buf.u16n();
      def.oobChild = buf.u16n();
      const len = buf.u8();
      def.multiChildren = new Array(len + 1);
      for (let i = 0; i <= len; i++) def.multiChildren[i] = buf.u16n();
    } else if (opcode === 107 || opcode === 109 || opcode === 111 || opcode === 122 || opcode === 123) {
      // flags
    } else if (opcode === 114 || opcode === 116 || opcode === 124 || opcode === 126 || opcode === 146) {
      buf.u16();
    } else if (opcode === 115 || opcode === 117) {
      buf.u16();
      buf.u16();
      buf.u16();
      buf.u16();
    } else {
      break;
    }
  }
  return def;
}
