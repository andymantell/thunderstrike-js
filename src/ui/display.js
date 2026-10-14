/**
 * The front-end draws into the same 256x128 off-screen buffer as the 3D
 * view and "blits" it into the cockpit window (CS:60A4). This module keeps
 * that buffer, loads IGR pictures into it the way sub_8DF1 does, and
 * provides the original's text and number printing helpers.
 */
import { Canvas8, Fonts } from '../render/hud.js';

export class Display {
  constructor(app) {
    this.app = app;
    this.data = app.data;
    this.ds = app.data.exe.ds;
    this.fonts = new Fonts(app.data.exe);
    this.work = new Canvas8(256, 128);     // segment [0x674E]
    this.textColour = 4;                   // [0x682A]
  }

  /** sub_619C: clear the work buffer. */
  clear() { this.work.clear(0); }

  /** [0x6754]: copy the work buffer into the cockpit window. */
  blit() { this.app.showBuffer(this.work); }

  /**
   * sub_8DF1: load a 256-wide picture at (x, y). `offset` is added to every
   * non-zero pixel and to the palette start (0xEC moves pictures 20 colours
   * down, clear of the cockpit palette). One-colour palettes are not loaded.
   */
  picture(img, x = 0, y = 0, offset = 0) {
    const w = this.work;
    for (let r = 0; r < img.height; r++) {
      for (let c = 0; c < img.width; c++) {
        let p = img.pixels[r * img.width + c];
        if (p) p = (p + offset) & 0xff;
        w.plot(x + c, y + r, p);
      }
    }
    if (img.colourCount !== 1) this.app.setColours((img.firstColour + offset) & 0xff, img.palette);
  }

  /** sub_8FB9: draw frame `n` of an animation at its stored position. */
  animFrame(anim, n) {
    const px = anim.frames[n] ?? anim.frames[0];
    for (let r = 0; r < anim.height; r++) for (let c = 0; c < anim.width; c++) {
      let p = px[r * anim.width + c];
      if (p) p = (p + 0xec) & 0xff;
      this.work.plot(anim.x + c, anim.y + r, p);
    }
  }

  /** sub_9D0B: 8x8 text, no shadow. */
  print(colour, col, row, text, max = Infinity) { return this.fonts.text8(this.work, col, row, text, colour, max, false); }
  /** sub_9D31: 8x8 text with a one-pixel shadow. */
  printShadow(colour, col, row, text, max = Infinity) { return this.fonts.text8(this.work, col, row, text, colour, max, true); }
  /** sub_9D57: 6x8 text, 43 columns. */
  print6(colour, col, row, text) {
    const start = col;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code === 13) { col = start; row++; continue; }
      if (code === 10) { col = 0; row++; continue; }
      this.fonts.glyph6(this.work, col * 6, row * 8, code, colour);
      col++;
      if (col >= 0x2b) { row++; col = start; }
    }
  }
  /** DS string helpers */
  str(off) { return this.ds.cstr(off); }

  /** sub_B737: two digits, leading zero shown as a space. */
  num2(col, row, value, colour) {
    const t = Math.trunc(value / 10);
    const s = (t ? String.fromCharCode(0x30 + t) : ' ') + String.fromCharCode(0x30 + (value % 10));
    this.printShadow(colour, col, row, s);
  }

  /** sub_B789: three digit rating 1..100 in the 8x8 (size 8) or 6x8 (size 6) font. */
  num3(col, row, value, size, colour) {
    let tens = Math.trunc(value / 10), hundred = 0;
    if (tens === 10) { tens = 0; hundred = 1; }
    const s = (hundred ? '1' : ' ') + (tens + hundred ? String.fromCharCode(0x30 + tens) : ' ') + String.fromCharCode(0x30 + (value % 10));
    if (size === 8) this.printShadow(colour, col, row, s);
    else this.print6(colour, col, row, s);
  }

  /** sub_B82A: a per-mille value as "xx.x" (the template keeps its own trailing characters). */
  permille(col, row, value, colour) {
    // digits go into the DS template at indices 4,2,1,0 (index 3 holds the point)
    const t = this.ds.u16(0xae3c);
    let v = value;
    for (let si = 4; si >= 0;) {
      let d = 0x30 + (v % 10);
      v = Math.trunc(v / 10);
      if (v === 0 && d === 0x30 && si < 2) d = 0x20;
      this.ds.w8(t + si, d);
      si--;
      if (si === 3) si--;
    }
    this.printShadow(colour, col, row, this.ds.cstr(t));
  }
}
