import { ByteBuffer } from '../ByteBuffer';
import { FrameDef, FramemapDef } from '../types';

export function decodeFramemap(data: Uint8Array, id: number): FramemapDef {
  const buf = new ByteBuffer(data);
  const length = buf.u8();
  const types = new Array<number>(length);
  const frameMaps = new Array<number[]>(length);

  for (let i = 0; i < length; i++) {
    types[i] = buf.u8();
  }
  for (let i = 0; i < length; i++) {
    frameMaps[i] = new Array<number>(buf.u8());
  }
  for (let i = 0; i < length; i++) {
    for (let j = 0; j < frameMaps[i].length; j++) {
      frameMaps[i][j] = buf.u8();
    }
  }

  return {
    id,
    length,
    types,
    frameMaps,
  };
}

export function decodeFrame(
  data: Uint8Array,
  archiveId: number,
  fileId: number,
  getFramemap: (framemapId: number) => Promise<FramemapDef | undefined>
): Promise<FrameDef | undefined> {
  const inBuf = new ByteBuffer(data);
  const dataBuf = new ByteBuffer(data);

  const framemapId = inBuf.u16();
  const length = inBuf.u8();
  dataBuf.setPos(3 + length);

  return getFramemap(framemapId).then((framemap) => {
    if (!framemap) return undefined;

    const indexFrameIds: number[] = [];
    const translatorX: number[] = [];
    const translatorY: number[] = [];
    const translatorZ: number[] = [];

    let lastOrigin = -1;
    let showing = false;
    let colorTransform = false;

    for (let i = 0; i < length; i++) {
      const flags = inBuf.u8();
      if (flags <= 0) continue;

      if (framemap.types[i] !== 0) {
        for (let prev = i - 1; prev > lastOrigin; prev--) {
          if (framemap.types[prev] === 0) {
            indexFrameIds.push(prev);
            translatorX.push(0);
            translatorY.push(0);
            translatorZ.push(0);
            break;
          }
        }
      }

      indexFrameIds.push(i);
      const defaultVal = framemap.types[i] === 3 ? 128 : 0;
      translatorX.push((flags & 1) !== 0 ? dataBuf.shortSmart() : defaultVal);
      translatorY.push((flags & 2) !== 0 ? dataBuf.shortSmart() : defaultVal);
      translatorZ.push((flags & 4) !== 0 ? dataBuf.shortSmart() : defaultVal);

      lastOrigin = i;
      if (framemap.types[i] === 5) showing = true;
      if (framemap.types[i] === 7) colorTransform = true;
    }

    return {
      id: (archiveId << 16) | fileId,
      archiveId,
      fileId,
      framemapId,
      framemap,
      indexFrameIds,
      translatorX,
      translatorY,
      translatorZ,
      showing,
      colorTransform,
    };
  });
}
