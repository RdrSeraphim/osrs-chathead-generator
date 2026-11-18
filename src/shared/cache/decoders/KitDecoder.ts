import { ByteBuffer } from '../ByteBuffer';
import { KitDef } from '../types';

export function decodeKit(data: Uint8Array, id: number): KitDef {
  const buf = new ByteBuffer(data);
  const def: KitDef = {
    id,
    bodyPartId: -1,
    models: [],
    chatheadModels: [-1, -1, -1, -1, -1],
    recolorFrom: [],
    recolorTo: [],
    retextureFrom: [],
    retextureTo: [],
    nonSelectable: false,
  };

  while (buf.remaining > 0) {
    const opcode = buf.u8();
    if (opcode === 0) break;

    if (opcode === 1) {
      def.bodyPartId = buf.u8();
    } else if (opcode === 2) {
      const len = buf.u8();
      def.models = new Array(len);
      for (let i = 0; i < len; i++) {
        def.models[i] = buf.u16();
      }
    } else if (opcode === 3) {
      def.nonSelectable = true;
    } else if (opcode === 5) {
      const len = buf.u8();
      def.models = new Array(len);
      for (let i = 0; i < len; i++) {
        def.models[i] = buf.modelId();
      }
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
    } else if (opcode >= 60 && opcode < 70) {
      def.chatheadModels[opcode - 60] = buf.u16();
    } else if (opcode >= 70 && opcode < 80) {
      def.chatheadModels[opcode - 70] = buf.modelId();
    } else {
      // Unknown opcode: stop gracefully
      break;
    }
  }

  return def;
}
