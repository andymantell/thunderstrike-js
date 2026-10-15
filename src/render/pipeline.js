/**
 * The original's polygon pipeline, reproduced step for step so that every
 * pixel of the 3D view comes out as it did on the PC:
 *
 *   near clip at Z = -390 by bisection        sub_43C5 / sub_44AE
 *   projection, truncating integer division    sub_4770
 *   back-face test for terrain                 sub_453D
 *   screen clip (left, bottom, right, top)     sub_08EE / sub_08F7
 *   edge walkers building the span table       sub_6870, sub_6A64
 *   span fill                                  sub_5E22
 *
 * The routines share scratch memory in DS (vertex banks at 0x685F, the span
 * table at 0x694F), and leftovers from one polygon are sometimes read by
 * the next. That memory is kept here as it is in the original. The result
 * of each polygon is a list of pixel runs [row, x0, x1] in the 256x128 view.
 */
import { s16 } from '../core/int.js';

const NEAR = -390;          // 0xFE7A
const XMAX = 255, YMAX = 127;
const BANK1 = 10;           // second vertex bank, 0x14 bytes on
// DS 0x685F..0x694E: X (40 words), Y (+0x50), Z (+0xA0)
const XO = 0, YO = 40, ZO = 80;

export class Pipeline {
  constructor() {
    this.v = new Int16Array(120);           // 0x685F
    this.count = 0;                          // [0x685D]
    this.table = new Uint8Array(0x200);      // 0x694F span table: left, right per row
    this.top = 0; this.bottom = 0; this.y0 = 0; this.rows = 0;   // [0x72B3] [0x72B5] [0x72B7] [0x72B9]
    this.halfWidth = false;                  // [0x6832] bit 7 clear: the attract demo's half-size picture
  }

  X(i) { return this.v[XO + i]; }
  Y(i) { return this.v[YO + i]; }
  Z(i) { return this.v[ZO + i]; }
  set(i, x, y, z) { this.v[XO + i] = x; this.v[YO + i] = y; if (z !== undefined) this.v[ZO + i] = z; }

  // ------------------------------------------------------------ inputs

  /** Load view-space vertices into bank 1, as sub_42C1 and the terrain loaders do. */
  loadView(pts) {
    pts.forEach(([x, y, z], i) => this.set(BANK1 + i, x, y, z));
    this.count = pts.length;
  }

  /** Load projected vertices straight into bank 0 (terrain cells already on screen). */
  loadScreen(pts) {
    pts.forEach(([x, y], i) => this.set(i, x, y));
    this.count = pts.length;
  }

  // ------------------------------------------------------------ geometry

  /** sub_4381: terrain cells reaching too far sideways are dropped. Reads four X words, used or not. */
  tooWide() {
    const x = [0, 1, 2, 3].map((i) => this.X(BANK1 + i));
    if (x[0] >= 0) return x.some((v) => v > 700);
    return x.some((v) => v < -700);
  }

  /** sub_43C5: clip against Z = -390, bank 1 into bank 0. */
  nearClip() {
    const n = this.count;
    let behind = 0;
    for (let i = 0; i < n; i++) if (this.Z(BANK1 + i) < NEAR) behind++;
    if (behind === 0) {
      for (let i = 0; i < n; i++) this.set(i, this.X(BANK1 + i), this.Y(BANK1 + i), this.Z(BANK1 + i));
      return;
    }
    this.count = 0;
    if (behind === n) return;
    let out = 0, prev = n - 1, pz = this.Z(BANK1 + prev);
    const emit = (x, y, z) => { this.set(out++, x, y, z); this.count++; };
    for (let i = 0; i < n; i++) {
      const c = BANK1 + i, p = BANK1 + prev, cz = this.Z(c);
      if (cz < NEAR) {
        if (pz >= NEAR) emit(...this.bisect(c, p));
      } else {
        if (pz < NEAR) emit(...this.bisect(p, c));
        emit(this.X(c), this.Y(c), cz);
      }
      pz = cz; prev = i;
    }
  }

  /** sub_44F2: halve the segment from `back` (behind) to `front` until Z is exactly -390. */
  bisect(back, front) {
    let s = [this.X(back), this.Y(back), this.Z(back)];
    let e = [this.X(front), this.Y(front), this.Z(front)];
    if (e[2] === NEAR) return e;
    const mid = (a, b) => a.map((v, k) => s16(v + b[k]) >> 1);
    let saved = e, m = mid(e, s);
    for (let guard = 0; guard < 64; guard++) {
      if (m[2] === NEAR) break;
      if (m[2] > NEAR) { saved = m; m = mid(m, s); } else { s = m; m = mid(m, saved); }
    }
    return m;
  }

  /** sub_4770: project bank 0 onto the 256x128 view. */
  project() {
    if (this.count < 3) return;
    for (let i = 0; i < this.count; i++) {
      const d = 0x190 + this.Z(i);
      this.v[XO + i] = s16(Math.trunc((this.X(i) * 100) / d) + 0x80);
      this.v[YO + i] = s16(0x40 - Math.trunc((this.Y(i) * 100) / d));
    }
  }

  /** sub_453D: true when the first three projected vertices turn the visible way. */
  frontFacing() {
    const x0 = this.X(0), x1 = this.X(1), x2 = this.X(2), y0 = this.Y(0), y1 = this.Y(1), y2 = this.Y(2);
    return s16(x0 - x1) * s16(y2 - y1) - s16(x2 - x1) * s16(y0 - y1) < 0;
  }

  /** sub_081F: objects skip clipping when on screen and drop faces with no vertex on it. */
  trivial() {
    const n = this.count;
    if (n < 3) { this.count = 0; return 'reject'; }
    let inside = 0;
    for (let i = 0; i < n; i++) if ((this.X(i) & 0xffff) <= XMAX && (this.Y(i) & 0xffff) <= YMAX) inside++;
    if (inside === 0) { this.count = 0; return 'reject'; }
    return inside === n ? 'accept' : 'clip';
  }

  /** sub_08FF: clip against the four screen edges, swapping banks between passes. */
  screenClip() {
    if (this.count < 3) return;
    let src = 0, dst = BANK1;
    const pass = (needed, clip, always) => {
      if (!always && !needed(src)) return true;
      this.count = clip(src, dst);
      if (this.count < 3) return false;
      if (!always) { const t = src; src = dst; dst = t; }
      return true;
    };
    const any = (from, f) => { for (let i = 0; i < this.count; i++) if (f(i + from)) return true; return false; };
    if (!pass((s) => any(s, (i) => this.X(i) < 0), (s, d) => this.clipEdge(s, d, 'x', 0, (v) => v >= 0))) return;
    if (!pass((s) => any(s, (i) => this.Y(i) > YMAX), (s, d) => this.clipEdge(s, d, 'y', YMAX, (v) => v <= YMAX))) return;
    if (!pass((s) => any(s, (i) => this.X(i) > XMAX), (s, d) => this.clipEdge(s, d, 'x', XMAX, (v) => v <= XMAX))) return;
    this.count = this.clipEdge(src, dst, 'y', 0, (v) => v >= 0);
    if (this.count < 3) return;
    if (dst !== 0) for (let i = 0; i < this.count; i++) this.set(i, this.X(dst + i), this.Y(dst + i));   // sub_08CC
  }

  /**
   * sub_09BD / 0A64 / 0B16 / 0BC8: one Sutherland-Hodgman pass. It starts
   * from the last vertex and then walks all of them, so an inside last
   * vertex is output twice.
   */
  clipEdge(src, dst, axis, edge, inside) {
    const A = axis === 'x' ? XO : YO, B = axis === 'x' ? YO : XO;
    const n = this.count, v = this.v;
    let out = 0;
    const emit = (a, b) => { v[A + dst + out] = a; v[B + dst + out] = b; out++; };
    let pa = v[A + src + n - 1], pb = v[B + src + n - 1];
    let isIn = inside(pa);
    if (isIn) emit(pa, pb);
    for (let i = 0; i < n; i++) {
      const ca = v[A + src + i], cb = v[B + src + i];
      if (isIn) {
        if (!inside(ca)) {
          emit(edge, s16(pb + Math.trunc((s16(cb - pb) * s16(edge - pa)) / s16(ca - pa))));
          isIn = false;
        } else emit(ca, cb);
      } else if (inside(ca)) {
        emit(edge, s16(cb + Math.trunc((s16(pb - cb) * s16(edge - ca)) / s16(pa - ca))));
        emit(ca, cb);
        isIn = true;
      }
      pa = ca; pb = cb;
    }
    return out;
  }

  // ------------------------------------------------------------ scan conversion

  /** sub_6FDD: last topmost and last bottommost vertex. */
  extremesLast() {
    let mn = 0x7fff, mx = -0x7fff, top = 0, bot = 0;
    for (let i = 0; i < this.count; i++) if (this.Y(i) <= mn) { mn = this.Y(i); top = i; }
    for (let i = 0; i < this.count; i++) if (this.Y(i) >= mx) { mx = this.Y(i); bot = i; }
    this.top = top; this.bottom = bot; this.y0 = mn; this.rows = mx - mn + 1;
  }

  /** sub_66BB: last topmost, first bottommost. */
  extremesFirst() {
    let mn = 0x7530, mx = -0x7530, top = 0, bot = 0;
    for (let i = 0; i < this.count; i++) {
      const y = this.Y(i);
      if (y > mx) { mx = y; bot = i; }
      if (y <= mn) { mn = y; top = i; }
    }
    this.top = top; this.bottom = bot; this.y0 = mn; this.rows = mx - mn + 1;
  }

  /**
   * One chain of edges from the top vertex to the bottom one, writing x for
   * each row into the left (side 0) or right (side 1) column of the table.
   * x steps in 8.8 fixed point from x0 + 0.5, the step added before each
   * row is written; flat edges write their start x. `upward` decides what
   * an edge going back up does: 'store' (like a flat edge) or 'abort'.
   */
  walk(dir, side, upward) {
    const n = this.count, t = this.table;
    let k = 0, i = this.top, x0 = this.X(i) & 0xff, y0 = this.Y(i);
    for (let guard = 0; guard < 64; guard++) {
      i = dir < 0 ? (i === 0 ? n - 1 : i - 1) : (i === n - 1 ? 0 : i + 1);
      const x1 = this.X(i) & 0xff, y1 = this.Y(i), dy = y1 - y0;
      if (dy < 0 && upward === 'abort') return;
      if (dy <= 0) t[(2 * k + side) & 0x1ff] = x0;
      else {
        const step = Math.trunc(((x1 - x0) * 256) / (dy + 1)) & 0xffff;
        let acc = (x0 << 8) | 0x80;
        for (let j = 0; j <= dy; j++) { acc = (acc + step) & 0xffff; t[(2 * (k + j) + side) & 0x1ff] = acc >> 8; }
        k += dy;
      }
      x0 = x1; y0 = y1;
      if (i === this.bottom) return;
    }
  }

  /** sub_6870 (object faces only): both chains, bottom = first lowest vertex. */
  walkFirst() {
    this.extremesFirst();
    if (this.rows >= 0x80) return;
    this.walk(-1, 0, 'store');
    this.walk(1, 1, 'store');
  }

  /**
   * sub_6690 / sub_6A64: both chains, bottom = last lowest vertex; a right
   * edge going up stops the right chain. In the attract demo every x in the
   * table is then halved (in place).
   */
  walkLast() {
    this.extremesLast();
    this.walk(-1, 0, 'store');
    this.walk(1, 1, 'abort');
    if (this.halfWidth) for (let k = 0; k < 2 * this.rows; k++) this.table[k & 0x1ff] >>= 1;
  }

  /** sub_5E22: the runs for this polygon from the span table. Reversed ends fill one pixel short. */
  spans() {
    const runs = [];
    for (let k = 0; k < this.rows; k++) {
      const l = this.table[(2 * k) & 0x1ff], r = this.table[(2 * k + 1) & 0x1ff], row = (this.y0 + k) & 0xff;
      if (r >= l) runs.push([row, l, r]);
      else {
        // starts at r - 1, which is the end of the previous row when r is 0
        if (r === 0) { runs.push([row - 1, 255, 255]); if (l >= 1) runs.push([row, 0, l - 1]); }
        else runs.push([row, r - 1, l - 1]);
      }
    }
    return runs;
  }

  /** sub_61D2: a particle's rows go through the same table (top row, [left, right] per stored row). */
  particle(top, rows) {
    rows.forEach(([l, r], k) => { this.table[(2 * k) & 0x1ff] = l; this.table[(2 * k + 1) & 0x1ff] = r; });
    this.y0 = top; this.rows = rows.length;
    return this.spans();
  }

  // ------------------------------------------------------------ the three callers

  /** sub_4568 + sub_45BF: an object face (back faces already removed). */
  objectFace(pts) {
    this.loadView(pts);
    this.nearClip();
    this.project();
    const t = this.trivial();
    if (t === 'reject') return null;
    if (t === 'clip') this.screenClip();
    if (this.count < 3) return null;
    this.walkFirst();
    this.walkLast();
    return this.spans();
  }

  /** sub_433D: a terrain cell with some corners behind the near plane (sub_186D). */
  terrainPartial(pts) {
    this.loadView(pts);
    if (this.tooWide()) return null;
    this.nearClip();
    this.project();
    if (this.count < 3 || !this.frontFacing()) return null;
    this.screenClip();
    if (this.count < 3) return null;
    this.walkLast();
    return this.spans();
  }

  /** sub_16C0 path: a cell whose corners are all in front, already projected. */
  terrainVisible(screenPts) {
    this.loadScreen(screenPts);
    if (!this.frontFacing()) return null;
    const outside = screenPts.some(([x, y]) => (x & 0xff00) || (y & 0xff80));
    if (outside) this.screenClip();
    if (this.count < 3) return null;
    this.walkLast();
    return this.spans();
  }
}
