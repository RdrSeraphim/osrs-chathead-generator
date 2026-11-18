import { CacheVersion, ItemID, Reader, Item as Cache2Item } from '@abextm/cache2';
import { ByteBuffer } from '../ByteBuffer';
import { ItemDef } from '../types';

export function decodeItem(
  data: Uint8Array,
  id: number,
  version?: CacheVersion,
  is317 = false
): ItemDef {
  if (!is317) {
    try {
      const r = new Reader(data, version);
      const item = Cache2Item.decode(r, id as ItemID);
      return {
        id: item.id,
        name: item.name || 'null',
        inventoryModel: item.inventoryModel ?? -1,
        wearpos1: item.wearpos1 ?? -1,
        wearpos2: item.wearpos2 ?? -1,
        wearpos3: item.wearpos3 ?? -1,
        maleChatheadModel: item.maleChatheadModel ?? -1,
        femaleChatheadModel: item.femaleChatheadModel ?? -1,
        maleChatheadModel1: item.maleChatheadModel1 ?? -1,
        femaleChatheadModel1: item.femaleChatheadModel1 ?? -1,
        recolorFrom: item.recolorFrom ?? [],
        recolorTo: item.recolorTo ?? [],
        retextureFrom: item.retextureFrom ?? [],
        retextureTo: item.retextureTo ?? [],
        noteLinkedItem: item.noteLinkedItem ?? -1,
        noteTemplate: item.noteTemplate ?? -1,
        placeholderLinkedItem: item.placeholderLinkedItem ?? -1,
        placeholderTemplate: item.placeholderTemplate ?? -1,
      };
    } catch {
      // Fall back to permissive decoder
    }
  }

  return decodeItemPermissive(data, id, is317);
}

function decodeItemPermissive(data: Uint8Array, id: number, is317: boolean): ItemDef {
  const buf = new ByteBuffer(data);
  const def: ItemDef = {
    id,
    name: 'null',
    inventoryModel: -1,
    wearpos1: -1,
    wearpos2: -1,
    wearpos3: -1,
    maleChatheadModel: -1,
    femaleChatheadModel: -1,
    maleChatheadModel1: -1,
    femaleChatheadModel1: -1,
    recolorFrom: [],
    recolorTo: [],
    retextureFrom: [],
    retextureTo: [],
    noteLinkedItem: -1,
    noteTemplate: -1,
    placeholderLinkedItem: -1,
    placeholderTemplate: -1,
  };

  while (buf.remaining > 0) {
    const opcode = buf.u8();
    if (opcode === 0) break;
    if (opcode === 1) def.inventoryModel = buf.u16();
    else if (opcode === 2) def.name = is317 ? buf.string317() : buf.string();
    else if (opcode === 3) is317 ? buf.string317() : buf.string();
    else if (opcode === 4 || opcode === 5 || opcode === 6 || opcode === 7 || opcode === 8) buf.u16();
    else if (opcode === 11 || opcode === 15 || opcode === 16 || opcode === 65) { /* flags */ }
    else if (opcode === 12) buf.i32();
    else if (opcode === 13) def.wearpos1 = buf.u8();
    else if (opcode === 14) def.wearpos2 = buf.u8();
    else if (opcode === 23) { buf.u16(); buf.u8(); }
    else if (opcode === 24) buf.u16();
    else if (opcode === 25) { buf.u16(); buf.u8(); }
    else if (opcode === 26) buf.u16();
    else if (opcode === 27) def.wearpos3 = buf.u8();
    else if (opcode >= 30 && opcode < 40) is317 ? buf.string317() : buf.string();
    else if (opcode === 40) {
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
    } else if (opcode === 42) buf.i8();
    else if (opcode === 51) def.maleChatheadModel = buf.modelId();
    else if (opcode === 52) def.maleChatheadModel1 = buf.modelId();
    else if (opcode === 53) def.femaleChatheadModel = buf.modelId();
    else if (opcode === 54) def.femaleChatheadModel1 = buf.modelId();
    else if (opcode === 75) buf.i16();
    else if (opcode === 78 || opcode === 79) buf.u16();
    else if (opcode === 90) def.maleChatheadModel = buf.u16();
    else if (opcode === 91) def.femaleChatheadModel = buf.u16();
    else if (opcode === 92) def.maleChatheadModel1 = buf.u16();
    else if (opcode === 93) def.femaleChatheadModel1 = buf.u16();
    else if (opcode === 94 || opcode === 95) buf.u16();
    else if (opcode === 97) def.noteLinkedItem = buf.u16();
    else if (opcode === 98) def.noteTemplate = buf.u16();
    else if (opcode === 99) buf.u16();
    else if (opcode >= 100 && opcode <= 109) { buf.u16(); buf.u16(); }
    else if (opcode === 110 || opcode === 111 || opcode === 112 || opcode === 139 || opcode === 140) buf.u16();
    else if (opcode === 113 || opcode === 114 || opcode === 115) buf.i8();
    else if (opcode === 148) def.placeholderLinkedItem = buf.u16();
    else if (opcode === 149) def.placeholderTemplate = buf.u16();
    else break;
  }
  return def;
}
