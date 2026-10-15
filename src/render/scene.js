/**
 * Builds the frame's draw list exactly the way the original renderer orders
 * it, in the original's view space:
 *   X right, Y up, Z forward; horizontal units are world/4, vertical units
 *   are world units; the eye sits at Z = -400 and projects with
 *   sx = 128 + 100*X/(Z+400), sy = 64 - 100*Y/(Z+400) onto a 256x128 view.
 *
 * Output is a list of primitives in painter's order:
 *   { kind: 'poly', colour, pts: [[x,y,z], ...] }   filled flat polygon
 *   { kind: 'spans', colour, z, top, rows: [[x0, x1], ...] }
 *                                                   particle (shots, explosions), already in screen
 *                                                   pixels: rows from `top`, x0..x1 inclusive
 * The three.js renderer turns these into triangles drawn without a depth
 * buffer, so overlaps resolve exactly like the original painter's algorithm.
 */
import { u8, s8, u16, s16 } from '../core/int.js';

const NEAR = -390;                  // 0xFE7A

export class SceneBuilder {
  constructor(data) {
    this.data = data;
    this.ds = data.exe.ds;
    this.tables = data.tables;
    this.models = data.models;
    // terrain grid arrays (16x16), indexed by cell = row*16 + col
    this.gx = new Int32Array(256);   // 0x23AE view X
    this.gz = new Int32Array(256);   // 0x25AE view Z
    this.gy = new Int32Array(256);   // 0x27AE view Y
    this.gb = new Uint8Array(256);   // 0x29AE layer B
    this.ga = new Uint8Array(256);   // 0x2BAE layer A
    this.vis = new Uint8Array(256);  // 0x31AE flags
    this.order = [];
    this.glowToggle = this.ds.u8(0x682e);   // [0x682E]
    this.animIndex = 0;              // [0x33AF]
  }

  /** Light direction (sub_49D4). */
  light(camAngle) {
    const tb = this.tables, a = u8(-camAngle);
    return [tb.sinMulB(0x1a, a), 0xf, tb.cosMulB(0x1a, a)];
  }

  /** sub_1BFA: rotate the 16x16 terrain window into view space. */
  buildGrid(g) {
    const tb = this.tables, map = g.terrain.map;
    const ang = g.camAngle;
    const sin = tb.sinB(ang), cos = tb.cosB(ang);
    const fx = (g.p.x >> 2) & 0xff, fz = (g.p.z >> 2) & 0xff;
    const originCol = ((g.p.x >> 10) - 8) & 0x3f;
    const originRow = ((g.p.z >> 10) - 8) & 0x3f;
    const xc = new Int32Array(16), xs = new Int32Array(16), zc = new Int32Array(16), zs = new Int32Array(16);
    let bx = s16(0xf800 - fx);
    for (let i = 0; i < 16; i++, bx = s16(bx + 0x100)) {
      xc[i] = s16(Math.floor(bx * cos / 16384));
      xs[i] = s16(Math.floor(bx * sin / 16384));
    }
    bx = s16(0x800 - fz);
    for (let j = 0; j < 16; j++, bx = s16(bx - 0x100)) {
      zc[j] = s16(Math.floor(bx * cos / 16384));
      zs[j] = s16(Math.floor(bx * sin / 16384));
    }
    let cell = (originRow << 6) | originCol;
    for (let j = 0; j < 16; j++) {
      for (let i = 0; i < 16; i++) {
        const k = j * 16 + i;
        const z = s16(xs[i] + zc[j]);
        this.gz[k] = z;
        this.vis[k] = z >= NEAR ? 1 : 0;
        this.gx[k] = s16(xc[i] - zs[j]);
        this.gb[k] = map[0x1000 + cell];
        this.ga[k] = map[cell];
        this.gy[k] = s16((map[cell] & 0xf0) - g.camHeight);
        cell = (cell & 0xfc0) | ((cell + 1) & 0x3f);
      }
      cell = ((cell - 0x40) & 0xfc0) | originCol;
    }
    this.originCol = originCol; this.originRow = originRow;
  }

  /** sub_3D32: objects inside the window, transformed and depth sorted. */
  buildObjects(g) {
    const o = g.o, tb = this.tables;
    const ang = g.camAngle;
    const sin = tb.sinB(ang), cos = tb.cosB(ang);
    const list = [];
    for (let s = 0; s < 24; s++) {
      if (o.type[s] === 0) continue;
      const gx = ((o.x[s] >> 10) - this.originCol) & 0x3f;
      const gzr = ((o.z[s] >> 10) - this.originRow) & 0x3f;
      if (gx & 0x30 || gzr & 0x30) continue;
      const j = (15 - gzr) & 0xff;
      o.cell[s] = (j * 16 + gx) * 2;    // word offset, as stored at 0x907
      const dx = s16(o.x[s] - g.p.x), dz = s16(o.z[s] - g.p.z);
      const x = s16(Math.floor((dx * cos - dz * sin) / 16384));
      const z = s16(Math.floor((dx * sin + dz * cos) / 16384));
      const y = s16(o.y[s] - g.camHeight);
      list.push({ s, x, y, z });
    }
    // the radar list (DS:0xC26) uses every object in the window
    this.radar = list.map((e) => ({ x: e.x >> 2, z: e.z >> 2, type: o.type[e.s] }));
    for (const e of list) {
      o.vxv[e.s] = u16(e.x >> 2); o.vyv[e.s] = u16(e.y); o.vzv[e.s] = u16(e.z >> 2);
    }
    // sub_3F3C bubble sort, far first
    for (let swapped = true; swapped;) {
      swapped = false;
      for (let i = 1; i < list.length; i++) {
        if (list[i].z > list[i - 1].z) { const t = list[i]; list[i] = list[i - 1]; list[i - 1] = t; swapped = true; }
      }
    }
    // cull by depth and width
    this.objects = list.filter((e) => {
      const vz = s16(o.vzv[e.s] - o.radius[e.s]);
      const vx = s16(o.vxv[e.s]);
      return vz > -250 && vz < 0x7d0 && vx <= 0x1f40 && vx >= -0x1f40;
    }).map((e) => e.s);
  }

  /** sub_1D2B: the order the 15x15 terrain cells are painted in. */
  buildOrder(camAngle) {
    const ds = this.ds;
    let al = u8(camAngle + 0x40);
    let step = 2, start = 0;
    if (u8(al + 0x20) & 0x80) { al = u8(al - 0x80); start = 0x1fe; step = -2; }
    let columnMajor = false;
    if (s8(al) >= 0x20) { columnMajor = true; al = u8(-al + 0x3f); }
    let base = 0x364c, reverse = false;
    if (s8(al) < 0) { base = 0x366a; reverse = true; al = u8(-al); }
    let si = ds.u16(0x360a + al * 2) + base;
    const skew = [];
    for (let i = 0; i < 16; i++) {
      let v = ds.s16(si);
      si += reverse ? -2 : 2;
      if (columnMajor) v = s16(v << 4);
      skew.push(v);
    }
    const out = [];
    let dx = 0;
    for (;;) {
      const batch = [];
      let bp = 0;
      for (let i = 0; i < 16; i++) {
        let ax = s16(skew[i] + dx);
        const ok = columnMajor ? (ax & 0xe00) === 0 : (ax & 0xe0) === 0;
        if (ok) batch.push(u16(ax + bp));
        bp += columnMajor ? 2 : 0x20;
      }
      dx += columnMajor ? 0x20 : 2;
      if (batch.length === 0) break;
      // sub_1E13: outermost cells first, alternating ends
      const tmp = [];
      let f = 0, b = batch.length - 1;
      while (tmp.length < batch.length) {
        tmp.push(batch[f++]);
        if (tmp.length < batch.length) tmp.push(batch[b--]);
      }
      if (step > 0) out.push(...tmp); else for (let i = tmp.length - 1; i >= 0; i--) out.push(tmp[i]);
    }
    this.order = out.map((w) => w >> 1);
    this.orderStart = start >> 1;
    this.orderStep = step >> 1;
  }

  /** sub_15A2 + model and particle submission. */
  build(g) {
    this.buildGrid(g);
    this.buildObjects(g);
    const camAngle = g.camAngle;
    this.buildOrder(camAngle);
    const L = this.light(camAngle);
    this.animIndex = (this.animIndex + 1) & 0xf;
    const anim = this.ds.u8(0x33b0 + this.animIndex);   // [0x33AE]
    const prims = [];
    const drawn = new Uint8Array(256);
    let pending = 0;
    let prev = 0;
    const objs = this.objects;
    const o = g.o;
    const n = this.order.length;
    let idx = this.orderStart;
    for (let c = 0; c < n; c++, idx += this.orderStep) {
      const k = this.order[(idx + n * 4) % n];
      if ((k & 0xf) !== 0xf && (k & 0xf0) !== 0xf0) this.terrainCell(k, anim, prims);
      drawn[k] |= 0x80;
      drawn[prev] |= 0x40;
      prev = k;
      while (pending < objs.length && (drawn[o.cell[objs[pending]] >> 1] & 0x40)) {
        this.object(g, objs[pending], L, prims);
        pending++;
      }
    }
    return prims;
  }

  terrainCell(k, anim, prims) {
    const raw = this.gb[k + 1];
    let colour = raw & 0x7f;
    if (colour < 0x10) colour = 0;
    if (colour >= 0x70) colour = anim;
    const A = k, B = k + 1, C = k + 17, D = k + 16;
    const v = this.vis;
    if (!(v[A] | v[B] | v[C] | v[D])) return;
    const P = (i) => [this.gx[i], this.gy[i], this.gz[i]];
    if (!(raw & 0x80)) { prims.push({ kind: 'poly', colour, pts: [P(A), P(B), P(C), P(D)] }); return; }
    if (this.gy[A] === this.gy[C]) {
      prims.push({ kind: 'poly', colour, pts: [P(A), P(B), P(D)] });
      prims.push({ kind: 'poly', colour, pts: [P(B), P(C), P(D)] });
    } else {
      prims.push({ kind: 'poly', colour, pts: [P(A), P(B), P(C)] });
      prims.push({ kind: 'poly', colour, pts: [P(A), P(C), P(D)] });
    }
  }

  /**
   * sub_5DE5: colours 0x80 and up are the engine glow. It follows the
   * player's thrust [0xBA] (dark when idle) and flickers: each glowing face
   * drawn flips bit 1.
   */
  glow(colour, g) {
    if (colour < 0x80) return colour;
    const t = g.p.thrust >> 4;
    if (t === 0) return 8;
    const c = (Math.min(t, 0xf) | 0x20) ^ this.glowToggle;
    this.glowToggle ^= 2;
    return c;
  }

  /**
   * sub_477C + sub_61D2: a particle as the original fills it. Centre and
   * radius are projected with truncating integer division, and each row's
   * half-width comes from the table for that radius (pointers at DS:0x6650
   * into segment 0x7D). Rows whose span lies wholly off one side are left
   * out of the span list, which moves the rows below them up, as in the
   * original.
   */
  disc(px, py, pz, r, colour) {
    const w = 0x190 + pz;
    if (w <= 0) return null;
    const cx = Math.trunc((px * 100) / w) + 0x80;
    const cy = 0x40 - Math.trunc((py * 100) / w);
    let rad = Math.trunc((r * 100) / w);
    if (rad < 0 || rad > 0x7f) rad = 0x7f;
    if (cx + rad < 0 || cx - rad > 0xff || cy + rad < 0 || cy - rad > 0x7f || rad === 0) return null;
    const img = this.data.exe.image;
    let si = 0x7d0 + this.ds.u16(0x6650 + (rad - 1) * 2);
    let top = cy - rad;
    if (top < 0) { si -= top; top = 0; }
    const count = Math.min(cy + rad, 0x7f) - top + 2;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const hw = img[si++];
      let left = cx - hw;
      if (left < 0) left = 0;
      else if (left > 0xff) continue;
      let right = cx + hw;
      if (right < 0) continue;
      if (right > 0xff) right = 0xff;
      rows.push([left, right]);
    }
    return { kind: 'spans', colour, z: pz, top, rows };
  }

  /** sub_3EF3: one object's faces (VGA path at 0x4143) or particle (0x3FA9). */
  object(g, s, L, prims) {
    const o = g.o, tb = this.tables;
    const model = o.model[s];
    const px = s16(o.vxv[s]), py = s16(o.vyv[s]), pz = s16(o.vzv[s]);
    if (model & 0x80) {
      const d = this.disc(px, py, pz, u8(-model), this.glow((model >> 8) & 0xff, g));
      if (d) prims.push(d);
      return;
    }
    const m = this.models.get(model & 0xffff);
    if (!m) return;
    const camAngle = g.camAngle;
    const yaw = u8(camAngle - o.yaw[s]);
    const pitch = o.pitch[s] & 0xff, roll = o.roll[s] & 0xff;
    const n = m.vertexCount;
    const vx = new Int32Array(n), vy = new Int32Array(n), vz = new Int32Array(n);
    const cm = (v, a) => tb.cosMulB(v, a), sm = (v, a) => tb.sinMulB(v, a);
    for (let i = 0; i < n; i++) {
      let x = m.verts[i * 3], y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
      let x1 = s8(cm(x, roll) - sm(y, roll));
      let y1 = s8(cm(y, roll) + sm(x, roll));
      let z1 = s8(cm(z, pitch) - sm(y1, pitch));
      let y2 = s8(cm(y1, pitch) + sm(z, pitch));
      let x2 = s8(cm(x1, yaw) - sm(z1, yaw));
      let z2 = s8(cm(z1, yaw) + sm(x1, yaw));
      if (i < m.positionCount) { vx[i] = x2 + px; vy[i] = y2 + py; vz[i] = z2 + pz; }
      else { vx[i] = x2; vy[i] = y2; vz[i] = z2; }
    }
    for (const f of m.faces) {
      const nv = f.normal;
      let sh = s8(s8((vy[nv] * L[1]) >> 8) + s8((vx[nv] * L[0]) >> 8) + s8((vz[nv] * L[2]) >> 8));
      if (sh < -8) sh = -8;
      const colour = ((f.colour & 0xf0) + sh + 8) & 0xff;
      if (f.idx.length >= 3 && !facesEye(vx, vy, vz, f.idx)) continue;
      prims.push({ kind: 'poly', colour: this.glow(colour, g), pts: f.idx.map((i) => [vx[i], vy[i], vz[i]]) });
    }
  }
}

/** sub_4875: back-face test against the eye at (0, 0, -400). */
function facesEye(vx, vy, vz, idx) {
  const v0 = idx[0], v1 = idx[1], v2 = idx[2];
  const ax = vx[v0] - vx[v1], ay = vy[v0] - vy[v1], az = vz[v0] - vz[v1];
  const bx = vx[v2] - vx[v1], by = vy[v2] - vy[v1], bz = vz[v2] - vz[v1];
  const cx = -vx[v1], cy = -vy[v1], cz = -400 - vz[v1];
  const t = (p) => s16(Math.floor(p / 256));
  const sum = t(az * by - ay * bz) * cx + t(ax * bz - az * bx) * cy + t(ay * bx - ax * by) * cz;
  return (sum | 0) >= 0;
}
