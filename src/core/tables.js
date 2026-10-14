import { s8, u8 } from './int.js';

/**
 * Lookup tables used by the original engine, all read from the user's data:
 *  - a 256-entry sine table (scale 16384) at DS:0xA350
 *  - a 33-entry arctangent table at DS:0xA330
 *  - BIN/N_SIN.BIN, a 128x128 table of v*256*sin(a*pi/128)+128 used to
 *    rotate the int8 model vertices.
 */
export class Tables {
  constructor(exe, nsinFile) {
    const ds = exe.ds;
    this.sin = new Int16Array(256);
    for (let i = 0; i < 256; i++) this.sin[i] = ds.s16(0xa350 + i * 2);
    this.atan = new Uint8Array(64);
    for (let i = 0; i < 64; i++) this.atan[i] = ds.u8(0xa330 + i);
    // N_SIN.BIN carries a 7-byte BSAVE header.
    const raw = nsinFile.subarray(7, 7 + 0x8000);
    this.nsin = new Int16Array(0x4000);
    for (let i = 0; i < 0x4000; i++) this.nsin[i] = (raw[i * 2] | (raw[i * 2 + 1] << 8)) << 16 >> 16;
  }

  /** sub_80f2: sine of a byte angle (256 = full turn), scale 16384. */
  sinB(a) { return this.sin[a & 0xff]; }
  /** sub_80fb */
  cosB(a) { return this.sin[(a + 0x40) & 0xff]; }

  /**
   * sub_49b8: signed byte value times sin(angle), using N_SIN.BIN.
   * Returns the full 16-bit table result (callers usually keep the high byte).
   */
  sinMul(value, angle) {
    let v = s8(value);
    let a = u8(angle);
    const sameSign = ((a ^ (v & 0xff)) & 0x80) === 0;
    const hi = (a & 0x80) !== 0;
    a = (a << 1) & 0xff;
    if (sameSign) {
      if (hi) v = -v;
      return this.nsin[((u8(v) << 7) | (a >> 1)) & 0x3fff];
    }
    if (!hi) v = -v;
    return -this.nsin[((u8(v) << 7) | (a >> 1)) & 0x3fff];
  }
  /** sub_49b5 */
  cosMul(value, angle) { return this.sinMul(value, angle + 0x40); }
  /** High byte (BH) of the sin/cos product, as the model rotation uses it. */
  sinMulB(value, angle) { return s8(this.sinMul(value, angle) >> 8); }
  cosMulB(value, angle) { return s8(this.cosMul(value, angle) >> 8); }

  /**
   * sub_808f: angle (byte) of the vector (dx, dz), 0 = +Z, 0x40 = +X.
   * Faithful to the original: ratio * 32 looked up in a 33 entry table.
   */
  atan2(dx, dz) {
    dx = (dx << 16) >> 16; dz = (dz << 16) >> 16;
    const ch = dx < 0 ? 0x80 : 0; // sign of x (high byte)
    const cl = dz < 0 ? 0x80 : 0;
    let ax = Math.abs(dx) & 0xffff, bx = Math.abs(dz) & 0xffff;
    let al;
    if (ax >= bx) {
      if (ax === bx) al = 0x20;
      else {
        const q = Math.floor((bx * 0x20) / ax);
        al = (0x40 - this.atan[q]) & 0xff;
      }
    } else {
      const q = Math.floor((ax * 0x20) / bx);
      al = this.atan[q];
    }
    if (cl) al = ((-al) + 0x80) & 0xff;
    if (ch) al = (-al) & 0xff;
    return al;
  }
}

/** sub_8134: the game's 8-bit linear congruential generator. */
export class Rng {
  constructor() { this.seed = 0; }
  reset() { this.seed = 0; }
  next() { this.seed = (this.seed * 5 + 0x65) & 0xff; return this.seed; }
}
