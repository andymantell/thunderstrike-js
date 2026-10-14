/**
 * 2D drawing into indexed buffers: the 256x128 HUD layer over the 3D view
 * and the 320x200 screen (cockpit panel, menus). Fonts are bitmaps in
 * TS.EXE's data segment:
 *   DS:0x8503  4x8 status font (top nibble of each row byte)
 *   DS:0x7383  8x8 font
 *   DS:0x7683  6x8 font
 *   DS:0x7A83  16x16 two-plane digits (cockpit counters)
 *   DS:0x7D03  16x16 two-plane font
 */
import { s16, u8 } from '../core/int.js';

export class Canvas8 {
  constructor(w, h, data) { this.w = w; this.h = h; this.d = data ?? new Uint8Array(w * h); }
  clear(c = 0) { this.d.fill(c); }
  plot(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
  hline(x, y, n, c) { for (let i = 0; i < n; i++) this.plot(x + i, y, c); }
  vline(x, y, n, c) { for (let i = 0; i < n; i++) this.plot(x, y + i, c); }
  blit(img, dx = 0, dy = 0, transparent = -1) {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const c = img.pixels[y * img.width + x];
      if (c !== transparent) this.plot(dx + x, dy + y, c);
    }
  }
  /** sub_5EF5-style line between two points. */
  line(x0, y0, x1, y1, c) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.plot(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
}

export class Fonts {
  constructor(exe) { this.ds = exe.ds; }

  /** sub_5D8C: 4x8 status text, colour 0x1F, cursor in pixels. */
  small(cv, x, y, text, colour = 0x1f) {
    for (const ch of text) {
      const base = 0x8503 + (ch.charCodeAt(0) & 0xff) * 8;
      for (let r = 0; r < 8; r++) {
        const bits = this.ds.u8(base + r);
        for (let b = 0; b < 4; b++) if (bits & (0x80 >> b)) cv.plot(x + b, y + r, colour);
      }
      x += 4;
    }
  }

  /** sub_657C: 8x8 text; with shadow true the glyph is first drawn offset by (1,1) in colour 0. */
  glyph8(cv, x, y, code, colour) {
    const base = 0x7383 + (code & 0xff) * 8;
    for (let r = 0; r < 8; r++) {
      const bits = this.ds.u8(base + r);
      for (let b = 0; b < 8; b++) if (bits & (0x80 >> b)) cv.plot(x + b, y + r, colour);
    }
  }

  /** sub_65CB: 6x8 text (menus). */
  glyph6(cv, x, y, code, colour) {
    const base = 0x7683 + (code & 0xff) * 8;
    for (let r = 0; r < 8; r++) {
      const bits = this.ds.u8(base + r);
      for (let b = 0; b < 6; b++) if (bits & (0x80 >> b)) cv.plot(x + b, y + r, colour);
    }
  }

  /** sub_652E / 64CB: 16x16 two bitplane glyphs; colours from planes (dl, dh) = (0x01, 0x0B). */
  big(cv, x, y, index, table = 0x7a83, opaque = true, colours = [0x01, 0x0b]) {
    let si = table + index * 64;
    for (let r = 0; r < 16; r++) {
      for (let half = 0; half < 2; half++) {
        const lo = this.ds.u8(si), hi = this.ds.u8(si + 1);
        si += 2;
        for (let b = 0; b < 8; b++) {
          const m1 = (lo << b) & 0x80 ? colours[0] : 0;
          const m2 = (hi << b) & 0x80 ? colours[1] : 0;
          const c = m1 | m2;
          if (opaque || c) cv.plot(x + half * 8 + b, y + r, c);
        }
      }
    }
  }

  /**
   * sub_4CF8: text with the 8x8 font in cells, honouring CR (back to the
   * start column, next row) and LF (column 0, next row). Draws at most `max`
   * characters and returns true if the whole string was drawn.
   */
  text8(cv, col, row, str, colour, max = Infinity, shadow = false) {
    const startCol = col;
    let n = 0;
    for (const ch of str) {
      if (n >= max) return false;
      n++;
      const code = ch.charCodeAt(0);
      if (code === 10) { col = 0; row++; continue; }
      if (code === 13) { col = startCol; row++; continue; }
      if (shadow) this.glyph8(cv, col * 8 + 1, row * 8 + 1, code, 0);
      this.glyph8(cv, col * 8, row * 8, code, colour);
      col = (col + 1) & 0x1f;
      if (col === 0) { row++; col = startCol; }
    }
    return true;
  }
}

/**
 * Per-frame HUD drawn over the 3D view (sub_0D6D, sub_0F4E, sub_1F72)
 * plus the persistent cockpit gauges and counters (sub_62BE, sub_21C4).
 */
export class Hud {
  constructor(data) {
    this.data = data;
    this.ds = data.exe.ds;
    this.fonts = new Fonts(data.exe);
    this.radarBlink = this.ds.u8(0x1911);   // [0x1911]
    this.pyramidBlink = this.ds.u8(0x1961); // [0x1961]
    this.radarTimer = 0;                    // [0x1965]
    this.textColour = this.ds.u8(0x682a);
  }

  /** View-layer drawing. `view` and `screen` are Canvas8. */
  draw(g, scene, view, screen, beep) {
    const f = this.fonts;
    view.clear(0);
    if (g.p.rail) f.small(view, 2 * 8, 1 * 8, this.ds.cstr(0xe39));
    this.gauges(g, screen);
    for (const m of g.msg.frame(beep)) f.small(view, m.col * 8, m.row * 8, m.text);
    this.podLabels(g, view);
    if (!g.msg.timer[9] && g.defenders) g.msg.post(0x12, 0xfa2, 0xffff);  // 1102
    this.compass(g, view);
    if (g.p.rail) this.railArrows(g, view);
    else { this.horizon(g, view); this.horizonBox(view); }
    this.turboMessages(g);
    this.radar(g, scene, view);
    this.roundText(g, view);
  }

  /** sub_62BE: the two diagonal bar gauges on the panel, one step per frame. */
  gauges(g, screen) {
    const step = (key, base, colourBase, target) => {
      let v = g.gauges[key];
      const cur = (v << 24) >> 24, want = (target << 24) >> 24;
      if (cur === want) return;
      let colour;
      if (cur > want) { v = (v - 1) & 0xffff; colour = 0; }
      else { v = (v + 1) & 0xffff; colour = ((v & 0xff) >> 1) + colourBase; }
      g.gauges[key] = v;
      const dl = v & 0xff;
      let di = base + s16(v) - dl * 320;
      for (let i = 0; i < 7; i++) {
        const p = (di + i) & 0xffff;
        if (p < 64000) screen.d[p] = colour;
      }
    };
    step('shield', 0xed15, 0x50, g.shield & 0xff);
    step('threat', 0xed24, 0x20, g.threat & 0xff);
  }

  /** sub_1075 */
  podLabels(g, view) {
    const o = g.o;
    for (let i = (g.podLabels?.length ?? 0) - 1; i >= 0; i--) {
      const s = g.podLabels[i];
      const x = s16(o.vxv[s]), y = s16(o.vyv[s]), z = s16(o.vzv[s]);
      if (z >= 0x7d0 || z < -390) continue;
      const d = z + 400;
      const sx = Math.trunc((x * 100) / d) + 0x80, sy = 0x40 - Math.trunc((y * 100) / d);
      if (sx < 8 || sx > 0xf0 || sy < 8 || sy > 0x70) continue;
      const bp = this.ds.u16(0x1951 + o.type[s] * 2);
      if (bp) this.fonts.small(view, (sx >> 3) * 8, (sy >> 3) * 8, this.ds.cstr(bp));
    }
  }

  /** sub_1122: heading triangle at the top right of the view. */
  compass(g, view) {
    const tb = this.data.tables;
    const pt = (bl) => {
      const a = u8(bl - g.p.yaw + 0x80);
      return [(tb.sinB(a) >> 11) + 0xe0, (tb.cosB(a) >> 11) + 0x30];
    };
    const a = pt(0), b = pt(0x64), c = pt(0x9c);
    view.line(a[0], a[1], b[0], b[1], 0xf);
    view.line(b[0], b[1], c[0], c[1], 0xf);
    view.line(c[0], c[1], a[0], a[1], 0xf);
  }

  /** sub_0F09: bank indicator line. */
  horizon(g, view) {
    let bl = g.o.roll[0] & 0xff, neg = false;
    if (bl & 0x80) { bl = (-bl) & 0xff; neg = true; }
    if (bl > 0x28) bl = 0x28;
    let al = this.ds.u8(0x1967 + bl * 2), ah = this.ds.s8(0x1968 + bl * 2);
    if (neg) ah = -ah;
    view.line(0xd4 + al, 0x16 + ah, 0xec - al, 0x16 - ah, 0xf);
  }

  /** sub_63E0 */
  horizonBox(view) {
    view.hline(0xd4, 10, 0x18, 0xf);
    view.hline(0xd4, 0x22, 0x19, 0xf);
    view.vline(0xd4, 10, 0x18, 0xf);
    view.vline(0xec, 10, 0x19, 0xf);
  }

  /** sub_633B: track junction arrows (left / centre / right). */
  railArrows(g, view) {
    const bl = g.turnIndicator & 0xff;
    const x0 = 0xda, y0 = 0x14;
    const put = (dx, dy, c) => view.plot(x0 + dx, y0 + dy, c);
    let c = (bl & 0x80) ? 0xf : 7;
    for (let i = 0; i < 9; i++) put(-1 + i, i, 0);
    [[0xff, 1], [0x1fe, 2], [0x2fd, 3], [0x3fc, 4], [0x4fd, 5], [0x5fe, 6], [0x6ff, 7]].forEach(([off]) => {
      put(off % 256, Math.floor(off / 256), c);
    });
    for (let i = 0; i < 9; i++) put(0, i, c);
    c = bl === 0 ? 0xf : 7;
    for (let i = 0; i < 8; i++) put(2 + i, 0, c);
    for (let i = 0; i < 7; i++) { put(2, 1 + i, c); put(9, 1 + i, c); }
    for (let i = 0; i < 8; i++) put(2 + i, 8, c);
    c = (bl !== 0 && !(bl & 0x80)) ? 0xf : 7;
    [[0x101, 1], [0x202, 2], [0x303, 3], [0x404, 4], [0x503, 5], [0x602, 6], [0x701, 7]].forEach(([off]) => {
      put(0xb + (off % 256), Math.floor(off / 256), c);
    });
    for (let i = 0; i < 9; i++) put(0xb, i, c);
  }

  /** sub_11A8 */
  turboMessages(g) {
    if (g.p.turbo) {
      if (g.p.turboTimer === 1 && g.turbos === 0) g.msg.post(0x02, 0xddf, 0xf);
      else g.msg.post(0x02, 0xdd1, 1);
      return;
    }
    if (g.turbos && (g.input.buttons & 1) && (g.frame & 1)) {
      this.ds.w8(0xdfc, 0x30 + g.turbos);
      g.msg.post(0x02, 0xdef, 0xa);
    }
  }

  /** sub_0F4E / sub_0FD8: scanner and arena map. */
  radar(g, scene, view) {
    const ds = this.ds;
    this.radarBlink ^= 0x0e;
    this.pyramidBlink ^= 8;
    let count = -1, enemies = -1;
    const dots = [];
    for (const e of scene.radar ?? []) {
      const ax = (e.x + 0x2000) & 0xffff;
      if (((ax >> 8) & 0xff) >= 0x40) continue;
      const az = (e.z + 0x2000) & 0xffff;
      if (((az >> 8) & 0xff) >= 0x40) continue;
      const x = ((ax << 1) >> 8) & 0xff;
      const y = (((0x4000 - az) << 1) >> 8) & 0xff;
      let col = e.type === 2 ? this.radarBlink : ds.u8(0x18bf + (e.type & 0xff));
      if (!col) continue;
      count++;
      if (col === 0xe || col === 0xb) enemies++;
      dots.push([x, y, col]);
    }
    g.radarCount = count & 0xffff;
    g.radarEnemies = enemies;
    if (count > 0) this.radarTimer = 0xa;
    if (this.radarTimer - 1 >= 0) {
      this.radarTimer--;
      for (const [x, y, c] of dots) view.plot(x + 0x40, y + 0x20, c);
      view.hline(0x68, 0x48, 8, 0xf); view.hline(0x68 + 0x28, 0x48, 8, 0xf);
      view.hline(0x68, 0x77, 8, 0xf); view.hline(0x68 + 0x28, 0x77, 8, 0xf);
      for (let i = 0; i < 0x2e; i++) { view.plot(0x68, 0x49 + i, 0xf); view.plot(0x68 + 0x2f, 0x49 + i, 0xf); }
    }
    // global map (0FD8 + 601E)
    const o = g.o;
    for (let s = 0; s < 24; s++) {
      const c = ds.u8(0x190f + (o.type[s] & 0xff));
      const col = (s === 0 || o.type[s] === 2) ? this.radarBlink : c;
      if (!col) continue;
      const x = (o.x[s] >> 8) >> 2, y = (((-(o.z[s] >> 8)) & 0xff) >> 2);
      view.plot(x + 0xc0, y + 0x40, col);
    }
    for (const p of g.terrain.pyramids) {
      if (p.timer === 0xffff || (p.timer & 0xff00) === 0xff00) continue;
      const col = (p.timer & 0xff00) ? this.pyramidBlink : 4;
      view.plot(((p.x >> 8) >> 2) + 0xc0, (((-(p.z >> 8)) & 0xff) >> 2) + 0x40, col);
    }
    view.hline(0xc0, 0x40, 8, 0xf); view.hline(0xc0 + 0x38, 0x40, 8, 0xf);
    view.hline(0xc0, 0x7f, 8, 0xf); view.hline(0xc0 + 0x38, 0x7f, 8, 0xf);
    for (let i = 0; i < 8; i++) {
      view.plot(0xc0, 0x41 + i, 0xf); view.plot(0xc0 + 0x3f, 0x41 + i, 0xf);
      view.plot(0xc0, 0x77 + i, 0xf); view.plot(0xc0 + 0x3f, 0x77 + i, 0xf);
    }
  }

  /** sub_1F72 */
  roundText(g, view) {
    if (g.roundOver) this.fonts.text8(view, 8, 5, this.ds.cstr(0x1000), this.textColour, g.roundOver);
    if (g.lostTimer) {
      // the original draws this with its "flashing" variant
      if (g.frame & 1) this.fonts.text8(view, 8, 7, this.ds.cstr(0x0fdd), 0xe);
    }
  }

  /** sub_21C4 / sub_21D0: installation and generator counters on the panel. */
  counters(g, screen) {
    this.fonts.big(screen, 16, 166, g.terrain.pyramidsLeft & 0xff);
    this.fonts.big(screen, 40, 166, g.terrain.bunkersLeft & 0xff);
  }
}
