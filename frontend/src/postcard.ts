// Minimal postcard codec for the messages we exchange with voxi-server.
// Wire format matches the Rust `postcard` crate:
//   - u8, i8           : 1 raw byte (i8 is zig-zagged into a varint, see writeI8)
//   - u16/u32/u64      : varint (LEB128)
//   - i16/i32/i64      : zig-zag then varint
//   - bool             : 1 byte 0/1
//   - string           : varint length + utf-8 bytes
//   - Vec<T>           : varint length + T*
//   - Option<T>        : tag byte 0 (None) | 1 (Some) + T
//   - tuple / struct   : fields concatenated in declaration order
//   - enum             : variant index as varint + variant payload
//   - fixed [u8; N]    : N raw bytes (no length prefix)
//
// Numeric range: we use JS Number throughout. Sequence numbers, frame sizes,
// and timing fields all fit comfortably under 2^53. Anything that wouldn't
// is a bug we'd rather catch than silently truncate.

export class Writer {
  private buf: number[] = [];

  // Returns a Uint8Array backed by a fresh ArrayBuffer (not ArrayBufferLike),
  // so the result can be passed to WebSocket.send under TS 5.7+ strict typing.
  bytes(): Uint8Array<ArrayBuffer> {
    const buffer = new ArrayBuffer(this.buf.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < this.buf.length; i++) view[i] = this.buf[i];
    return view;
  }

  u8(v: number): this {
    if (v < 0 || v > 0xff) throw new Error(`u8 out of range: ${v}`);
    this.buf.push(v);
    return this;
  }

  // postcard encodes both u8 and i8 as 1 raw byte. Signed values use
  // two's-complement bit pattern.
  i8(v: number): this {
    if (v < -128 || v > 127) throw new Error(`i8 out of range: ${v}`);
    this.buf.push(v & 0xff);
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  // LEB128 unsigned varint.
  varint(v: number): this {
    if (v < 0) throw new Error(`varint needs non-negative, got ${v}`);
    let n = v;
    while (n >= 0x80) {
      this.buf.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.buf.push(n & 0x7f);
    return this;
  }

  // Signed varint via zig-zag.
  ivarint(v: number): this {
    return this.varint(zigzag(v));
  }

  str(s: string): this {
    const enc = new TextEncoder().encode(s);
    this.varint(enc.length);
    for (let i = 0; i < enc.length; i++) this.buf.push(enc[i]);
    return this;
  }

  fixedBytes(b: Uint8Array): this {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i]);
    return this;
  }

  option<T>(v: T | null | undefined, encode: (w: Writer, x: T) => void): this {
    if (v === null || v === undefined) return this.u8(0);
    this.u8(1);
    encode(this, v);
    return this;
  }

  vec<T>(items: readonly T[], encode: (w: Writer, x: T) => void): this {
    this.varint(items.length);
    for (const item of items) encode(this, item);
    return this;
  }

  variant(index: number): this {
    return this.varint(index);
  }
}

export class Reader {
  private view: Uint8Array;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.view = buf;
  }

  remaining(): number {
    return this.view.length - this.pos;
  }

  ended(): boolean {
    return this.pos >= this.view.length;
  }

  u8(): number {
    if (this.pos >= this.view.length) throw new Error("postcard: read past end");
    return this.view[this.pos++];
  }

  i8(): number {
    const b = this.u8();
    return b > 127 ? b - 256 : b;
  }

  bool(): boolean {
    const b = this.u8();
    if (b !== 0 && b !== 1) throw new Error(`postcard: bool not 0/1: ${b}`);
    return b === 1;
  }

  varint(): number {
    let result = 0;
    let mult = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mult;
      if ((b & 0x80) === 0) return result;
      mult *= 128;
    }
    throw new Error("postcard: varint too long");
  }

  ivarint(): number {
    return unzigzag(this.varint());
  }

  str(): string {
    const len = this.varint();
    if (this.pos + len > this.view.length) {
      throw new Error("postcard: string body past end");
    }
    const slice = this.view.subarray(this.pos, this.pos + len);
    this.pos += len;
    return new TextDecoder().decode(slice);
  }

  fixedBytes(n: number): Uint8Array {
    if (this.pos + n > this.view.length) {
      throw new Error("postcard: fixed bytes past end");
    }
    const slice = this.view.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  option<T>(decode: (r: Reader) => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) return decode(this);
    throw new Error(`postcard: option tag not 0/1: ${tag}`);
  }

  vec<T>(decode: (r: Reader) => T): T[] {
    const len = this.varint();
    const out: T[] = new Array(len);
    for (let i = 0; i < len; i++) out[i] = decode(this);
    return out;
  }

  variant(): number {
    return this.varint();
  }
}

function zigzag(v: number): number {
  // Equivalent to (n << 1) ^ (n >> bits-1) without bit width concerns.
  return v >= 0 ? 2 * v : -2 * v - 1;
}

function unzigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}
