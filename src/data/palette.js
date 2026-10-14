/**
 * The VGA palette is assembled at run time exactly like the original:
 *  - colours 0x10..0x7F: seven 16-shade ramps from DS:0x8B24
 *  - colours 0x80..0x9F: the arena's sky gradient (SKYn.DAT)
 *  - other ranges: supplied by whichever IGR picture is on screen.
 * Values are 6-bit VGA DAC levels.
 */
export class Palette {
  constructor() { this.dac = new Uint8Array(768); }
  set(first, rgb) { this.dac.set(rgb.subarray(0, Math.min(rgb.length, 768 - first * 3)), first * 3); }
  clone() { const p = new Palette(); p.dac.set(this.dac); return p; }
  /** 8-bit sRGB triplet for a colour index (VGA 6-bit -> 8-bit like a real DAC: v*255/63). */
  rgb(i) {
    const o = (i & 0xff) * 3;
    return [this.dac[o] * 255 / 63 | 0, this.dac[o + 1] * 255 / 63 | 0, this.dac[o + 2] * 255 / 63 | 0];
  }
  /** Packed 0xRRGGBB. */
  hex(i) { const [r, g, b] = this.rgb(i); return (r << 16) | (g << 8) | b; }
  /** 256 entries of Uint32 RGBA (little endian ABGR) for canvas blits. */
  rgba32() {
    const out = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { const [r, g, b] = this.rgb(i); out[i] = 0xff000000 | (b << 16) | (g << 8) | r; }
    return out;
  }
}

export function basePalette(exe) {
  const p = new Palette();
  p.set(0x10, exe.ds.slice(0x8b24, 0x70 * 3));
  return p;
}
