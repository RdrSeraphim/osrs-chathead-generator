const CP1252_EXT = '€?‚ƒ„…†‡ˆ‰Š‹Œ?Ž??‘’“”•–—˜™š›œ?žŸ';

const CP1252_TABLE: string[] = (() => {
  const table = new Array<string>(256);
  for (let i = 0; i < 256; i++) {
    const ei = i - 128;
    if (ei > 0 && ei < CP1252_EXT.length) {
      table[i] = CP1252_EXT.charAt(ei);
    } else {
      table[i] = String.fromCodePoint(i);
    }
  }
  return table;
})();

/**
 * Big-endian binary reader respecting subarray byteOffset and byteLength.
 */
export class ByteBuffer {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  public pos = 0;

  constructor(data: Uint8Array | ArrayBuffer) {
    if (data instanceof ArrayBuffer) {
      this.bytes = new Uint8Array(data);
      this.view = new DataView(data);
    } else {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
  }

  get length(): number {
    return this.view.byteLength;
  }

  get remaining(): number {
    return this.view.byteLength - this.pos;
  }

  setPos(pos: number): void {
    this.pos = pos;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  i8(): number {
    return this.view.getInt8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  u16n(): number {
    const v = this.u16();
    return v === 0xffff ? -1 : v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, false);
    this.pos += 2;
    return v;
  }

  u24(): number {
    const p = this.pos;
    this.pos += 3;
    return (
      (this.view.getUint8(p) << 16) |
      (this.view.getUint8(p + 1) << 8) |
      this.view.getUint8(p + 2)
    );
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  shortSmart(): number {
    const peek = this.view.getUint8(this.pos);
    return peek < 128 ? this.u8() - 64 : this.u16() - 49152;
  }

  uSmart(): number {
    const peek = this.view.getUint8(this.pos);
    return peek < 128 ? this.u8() : this.u16() - 0x8000;
  }

  u8o16m1(): number {
    const peek = this.view.getUint8(this.pos);
    return peek < 128 ? this.u8() - 1 : this.u16() - 0x8001;
  }

  bigSmart2(): number {
    const peek = this.view.getUint8(this.pos);
    if ((peek & 0x80) !== 0) {
      return this.i32() & 0x7fffffff;
    }
    return this.u16n();
  }

  modelId(): number {
    return this.i32();
  }

  string(): string {
    let out = '';
    while (this.pos < this.length) {
      const c = this.u8();
      if (c === 0) break;
      out += CP1252_TABLE[c];
    }
    return out;
  }

  /**
   * Classic 317 string terminator is newline (10) instead of 0.
   */
  string317(): string {
    let out = '';
    while (this.pos < this.length) {
      const c = this.u8();
      if (c === 10 || c === 0) break;
      out += CP1252_TABLE[c];
    }
    return out;
  }

  slice(start: number, end?: number): Uint8Array {
    return this.bytes.subarray(start, end);
  }

  readBytes(len: number): Uint8Array {
    const s = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}
