import { AnimationID, CacheVersion, Reader, Animation as Cache2Animation } from '@abextm/cache2';
import { ByteBuffer } from '../ByteBuffer';
import { SeqDef } from '../types';

export function decodeSeq(
  data: Uint8Array,
  id: number,
  version?: CacheVersion,
  is317 = false
): SeqDef {
  if (!is317) {
    try {
      const r = new Reader(data, version);
      const anim = Cache2Animation.decode(r, id as AnimationID);
      const frameIds = (anim.frameIDs ?? []).map(([hi, lo]) => ((hi & 0xffff) << 16) | (lo & 0xffff));
      const chatFrameIds = (anim.chatheadFrameIDs ?? []).map(
        ([hi, lo]) => ((hi & 0xffff) << 16) | (lo & 0xffff)
      );
      return {
        id: anim.id,
        name: anim.debugName,
        frameLengths: anim.frameLengths ?? [],
        frameIds,
        chatFrameIds,
        frameStep: anim.frameStep ?? -1,
        interleaveLeave: anim.interleaveLeave,
        animMayaId: anim.animMayaID ?? -1,
        animMayaStart: anim.animMayaStart ?? 0,
        animMayaEnd: anim.animMayaEnd ?? 0,
      };
    } catch {
      // Fallback for older / 317 sequence formats
    }
  }

  return decodeSeqPermissive(data, id);
}

function decodeSeqPermissive(data: Uint8Array, id: number): SeqDef {
  const buf = new ByteBuffer(data);
  const def: SeqDef = {
    id,
    frameLengths: [],
    frameIds: [],
    chatFrameIds: [],
    frameStep: -1,
    animMayaId: -1,
    animMayaStart: 0,
    animMayaEnd: 0,
  };

  while (buf.remaining > 0) {
    const opcode = buf.u8();
    if (opcode === 0) break;

    if (opcode === 1) {
      const len = buf.u16();
      def.frameLengths = new Array(len);
      def.frameIds = new Array(len);
      for (let i = 0; i < len; i++) def.frameLengths[i] = buf.u16();
      for (let i = 0; i < len; i++) def.frameIds[i] = buf.u16();
      for (let i = 0; i < len; i++) def.frameIds[i] |= buf.u16() << 16;
    } else if (opcode === 2) {
      def.frameStep = buf.u16();
    } else if (opcode === 3) {
      const len = buf.u8();
      def.interleaveLeave = new Array(len + 1);
      for (let i = 0; i < len; i++) def.interleaveLeave[i] = buf.u8();
      def.interleaveLeave[len] = 9999999;
    } else if (opcode === 4) {
      // stretches
    } else if (opcode === 5 || opcode === 8 || opcode === 9 || opcode === 10 || opcode === 11) {
      buf.u8();
    } else if (opcode === 6 || opcode === 7) {
      buf.u16();
    } else if (opcode === 12) {
      const len = buf.u8();
      def.chatFrameIds = new Array(len);
      for (let i = 0; i < len; i++) def.chatFrameIds[i] = buf.u16();
      for (let i = 0; i < len; i++) def.chatFrameIds[i] |= buf.u16() << 16;
    } else if (opcode === 13) {
      // In modern OSRS this is animMayaId (4 bytes); in older 317/OSRS it was frameSounds count
      if (buf.remaining >= 4) {
        def.animMayaId = buf.i32();
      } else {
        break;
      }
    } else if (opcode === 15) {
      def.animMayaStart = buf.u16();
      def.animMayaEnd = buf.u16();
    } else if (opcode === 18) {
      def.name = buf.string();
    } else {
      break;
    }
  }

  return def;
}
