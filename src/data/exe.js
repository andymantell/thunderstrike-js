/**
 * Access to the original TS.EXE image.
 *
 * Thunderstrike is a small-model real-mode program with three relevant
 * paragraphs-aligned segments inside the load image:
 *   0x007d  lookup tables          (image offset 0x07d0)
 *   0x0485  code segment (CS)      (image offset 0x4850)
 *   0x10a4  data segment (DS)      (image offset 0x10a40)
 * Everything the port needs from the executable (palettes, 3D models,
 * trig tables, round tables, text) is read from DS at the original offsets,
 * so no game content has to be shipped with this code.
 */
const CODE_SEG = 0x0485;
const DATA_SEG = 0x10a4;

export class Segment {
  constructor(bytes, base) {
    this.bytes = bytes;
    this.base = base;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(off) { return this.bytes[(this.base + (off & 0xffff))] ?? 0; }
  s8(off) { return (this.u8(off) << 24) >> 24; }
  u16(off) { return this.u8(off) | (this.u8(off + 1) << 8); }
  s16(off) { return (this.u16(off) << 16) >> 16; }
  w8(off, v) { this.bytes[this.base + (off & 0xffff)] = v & 0xff; }
  w16(off, v) { this.w8(off, v); this.w8(off + 1, v >> 8); }
  slice(off, len) { return this.bytes.slice(this.base + off, this.base + off + len); }
  /** NUL-terminated ASCII string. */
  cstr(off, max = 256) {
    let s = '';
    for (let i = 0; i < max; i++) {
      const c = this.u8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

export class Executable {
  constructor(fileBytes) {
    const b = fileBytes;
    if (b[0] !== 0x4d || b[1] !== 0x5a) throw new Error('TS.EXE: not an MZ executable');
    const headerParas = b[8] | (b[9] << 8);
    // keep a private copy: the game patches some strings in DS at run time
    this.image = b.slice(headerParas * 16);
    if (this.image.length < DATA_SEG * 16 + 0xc000) throw new Error('TS.EXE: unexpected size, is this the 1.1 DOS release?');
    this.cs = new Segment(this.image, CODE_SEG * 16);
    this.ds = new Segment(this.image, DATA_SEG * 16);
  }
}
