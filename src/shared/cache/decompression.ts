import pako from 'pako';
import seekBzip from 'seek-bzip';
import { ByteBuffer } from './ByteBuffer';

/**
 * Decompress a JS5 container blob (compression byte + 4-byte length + payload).
 * Also handles raw uncompressed or raw gzipped blobs (e.g. from 317/flatcache).
 */
export function decompressJs5(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;

  // Detect raw GZIP stream (magic 0x1f 0x8b) for raw .dat files or 317 models
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return pako.ungzip(data);
  }

  // Detect raw BZIP2 stream ('BZh')
  if (data.length >= 3 && data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68) {
    return decompressBzip2WithHeader(data);
  }

  if (data.length < 5) return data;

  const buf = new ByteBuffer(data);
  const compression = buf.u8();
  const compressedLen = buf.i32();

  // Sanity check: if it doesn't match a JS5 container envelope, treat as raw decompressed data
  if (
    compression > 2 ||
    compressedLen < 0 ||
    compressedLen > data.length - 5
  ) {
    return data;
  }

  if (compression === 0) {
    return data.subarray(5, 5 + compressedLen);
  }

  if (data.length < 9) return data;
  const uncompressedLen = buf.i32();
  const payload = data.subarray(9, 9 + compressedLen);

  if (compression === 1) {
    return decompressBzip2WithoutHeader(payload, uncompressedLen);
  }

  // compression === 2 (GZIP)
  return pako.ungzip(payload);
}

export function decompressBzip2WithoutHeader(payload: Uint8Array, expectedSize?: number): Uint8Array {
  const withHeader = new Uint8Array(4 + payload.length);
  withHeader[0] = 0x42; // 'B'
  withHeader[1] = 0x5a; // 'Z'
  withHeader[2] = 0x68; // 'h'
  withHeader[3] = 0x31; // '1'
  withHeader.set(payload, 4);
  return seekBzip.decode(withHeader, expectedSize);
}

function decompressBzip2WithHeader(data: Uint8Array): Uint8Array {
  return seekBzip.decode(data);
}

/**
 * Pack a payload into a JS5 container (compression 0 = none, 2 = GZIP).
 */
export function packJs5(payload: Uint8Array, compress: boolean = false): Uint8Array {
  if (!compress) {
    const out = new Uint8Array(5 + payload.length);
    const dv = new DataView(out.buffer);
    out[0] = 0;
    dv.setInt32(1, payload.length, false);
    out.set(payload, 5);
    return out;
  }

  const gz = pako.gzip(payload);
  const out = new Uint8Array(9 + gz.length);
  const dv = new DataView(out.buffer);
  out[0] = 2;
  dv.setInt32(1, gz.length, false);
  dv.setInt32(5, payload.length, false);
  out.set(gz, 9);
  return out;
}

/**
 * Unpack a JS5 multi-file archive given its ordered file IDs.
 */
export function unpackMultiFileArchive(
  decompressed: Uint8Array,
  fileIds: number[]
): Map<number, Uint8Array> {
  const result = new Map<number, Uint8Array>();
  if (fileIds.length === 0) return result;
  if (fileIds.length === 1) {
    result.set(fileIds[0], decompressed);
    return result;
  }

  const fileCount = fileIds.length;
  const dv = new DataView(
    decompressed.buffer,
    decompressed.byteOffset,
    decompressed.byteLength
  );
  const numChunks = dv.getUint8(decompressed.byteLength - 1);
  let off = decompressed.byteLength - 1 - numChunks * fileCount * 4;
  let dataOff = 0;

  if (numChunks === 1) {
    let size = 0;
    for (let i = 0; i < fileCount; i++) {
      size += dv.getInt32(off, false);
      off += 4;
      result.set(fileIds[i], decompressed.subarray(dataOff, dataOff + size));
      dataOff += size;
    }
    return result;
  }

  const stride = numChunks + 1;
  const sizes = new Uint32Array(stride * fileCount);
  for (let ch = 0; ch < numChunks; ch++) {
    let size = 0;
    for (let i = 0; i < fileCount; i++) {
      size += dv.getInt32(off, false);
      off += 4;
      const soff = i * stride;
      sizes[soff] += size;
      sizes[soff + 1 + ch] = size;
    }
  }

  const buffers: Uint8Array[] = [];
  for (let i = 0; i < fileCount; i++) {
    const soff = i * stride;
    const buf = new Uint8Array(sizes[soff]);
    buffers.push(buf);
    result.set(fileIds[i], buf);
    sizes[soff] = 0;
  }

  for (let ch = 0; ch < numChunks; ch++) {
    for (let i = 0; i < fileCount; i++) {
      const soff = i * stride;
      const chunkSize = sizes[soff + 1 + ch];
      const start = sizes[soff];
      buffers[i].set(decompressed.subarray(dataOff, dataOff + chunkSize), start);
      sizes[soff] = start + chunkSize;
      dataOff += chunkSize;
    }
  }

  return result;
}

/**
 * Pack multiple files into a single JS5 multi-file archive buffer (1 chunk).
 */
export function packMultiFileArchive(files: Array<[number, Uint8Array]>): {
  fileIds: number[];
  data: Uint8Array;
} {
  const sorted = [...files].sort((a, b) => a[0] - b[0]);
  const fileIds = sorted.map(([id]) => id);
  if (sorted.length === 1) {
    return { fileIds, data: sorted[0][1] };
  }

  const totalDataLen = sorted.reduce((acc, [, bytes]) => acc + bytes.length, 0);
  const trailerLen = sorted.length * 4 + 1;
  const out = new Uint8Array(totalDataLen + trailerLen);
  const dv = new DataView(out.buffer);

  let dataPos = 0;
  for (const [, bytes] of sorted) {
    out.set(bytes, dataPos);
    dataPos += bytes.length;
  }

  // Delta-encoded sizes
  let prevSize = 0;
  let trailerPos = totalDataLen;
  for (const [, bytes] of sorted) {
    dv.setInt32(trailerPos, bytes.length - prevSize, false);
    prevSize = bytes.length;
    trailerPos += 4;
  }
  out[trailerPos] = 1; // 1 chunk

  return { fileIds, data: out };
}
