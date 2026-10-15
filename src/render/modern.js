/**
 * Enhanced rendering: the same scene as SceneBuilder (the same terrain
 * window, objects, colours and painter's order) but worked out in floating
 * point and handed to three.js as view-space polygons, so the GPU draws it
 * with perspective at screen resolution. Angles may be fractional, which is
 * what the in-between frames of the smooth modes need.
 *
 * View space is the original's: x and z in quarter world units, y in world
 * units, the eye 400 units behind the screen plane.
 */
import { SceneBuilder } from './scene.js';
import { s8, u8 } from '../core/int.js';

const TURN = (2 * Math.PI) / 256;   // radians per angle unit (bytes)
const wrap16 = (v) => ((v % 65536) + 98304) % 65536 - 32768;   // signed 16-bit difference, kept fractional

export class ModernSceneBuilder extends SceneBuilder {
  /** sub_1BFA in floats: the 16x16 window corners in view space. */
  buildGrid(g) {
    const map = g.terrain.map;
    const a = (g.camYaw / 256) * TURN, sin = Math.sin(a), cos = Math.cos(a);
    const originCol = ((Math.floor(g.p.x) >> 10) - 8) & 0x3f;
    const originRow = ((Math.floor(g.p.z) >> 10) - 8) & 0x3f;
    // corner (i, j) relative to the craft, in quarter units (the grid is 0x100 apart)
    const fx = (g.p.x / 4) % 256, fz = (g.p.z / 4) % 256;
    let cell = (originRow << 6) | originCol;
    for (let j = 0; j < 16; j++) {
      const dz = 0x800 - fz - j * 0x100;
      for (let i = 0; i < 16; i++) {
        const k = j * 16 + i, dx = -0x800 - fx + i * 0x100;
        this.gx[k] = dx * cos - dz * sin;
        this.gz[k] = dx * sin + dz * cos;
        this.vis[k] = this.gz[k] >= -390 ? 1 : 0;
        this.gb[k] = map[0x1000 + cell];
        this.ga[k] = map[cell];
        this.gy[k] = (map[cell] & 0xf0) - g.camHeight;
        cell = (cell & 0xfc0) | ((cell + 1) & 0x3f);
      }
      cell = ((cell - 0x40) & 0xfc0) | originCol;
    }
    this.originCol = originCol; this.originRow = originRow;
  }

  /** sub_3D32 in floats; view positions go to fx/fy/fz instead of the object table. */
  buildObjects(g) {
    const o = g.o;
    const a = (g.camYaw / 256) * TURN, sin = Math.sin(a), cos = Math.cos(a);
    this.fx = new Float64Array(24); this.fy = new Float64Array(24); this.fz = new Float64Array(24);
    const list = [];
    for (let s = 0; s < 24; s++) {
      if (o.type[s] === 0) continue;
      const gx = ((Math.floor(o.x[s]) >> 10) - this.originCol) & 0x3f;
      const gzr = ((Math.floor(o.z[s]) >> 10) - this.originRow) & 0x3f;
      if (gx & 0x30 || gzr & 0x30) continue;
      o.cell[s] = (((15 - gzr) & 0xff) * 16 + gx) * 2;
      const dx = wrap16(o.x[s] - g.p.x), dz = wrap16(o.z[s] - g.p.z);
      const x = (dx * cos - dz * sin) / 4, z = (dx * sin + dz * cos) / 4;
      this.fx[s] = x; this.fy[s] = o.y[s] - g.camHeight; this.fz[s] = z;
      list.push({ s, z });
    }
    list.sort((p, q) => q.z - p.z);   // far first, like the bubble sort of sub_3F3C
    this.objects = list.filter((e) => {
      const vz = this.fz[e.s] - o.radius[e.s], vx = this.fx[e.s];
      return vz > -250 && vz < 0x7d0 && vx <= 0x1f40 && vx >= -0x1f40;
    }).map((e) => e.s);
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
    const poly = (...pts) => prims.push({ kind: 'poly', colour, pts });
    if (!(raw & 0x80)) poly(P(A), P(B), P(C), P(D));
    else if (this.gy[A] !== this.gy[C]) { poly(P(A), P(B), P(C)); poly(P(A), P(C), P(D)); }
    else { poly(P(A), P(B), P(D)); poly(P(B), P(C), P(D)); }
  }

  /** One object: model rotated in floats, colours shaded as the original does. */
  object(g, s, L, prims) {
    const o = g.o;
    const model = o.model[s] & 0xffff;
    const px = this.fx[s], py = this.fy[s], pz = this.fz[s];
    if (model & 0x80) {
      prims.push({ kind: 'disc', colour: this.glow((model >> 8) & 0xff, g), x: px, y: py, z: pz, r: u8(-model) });
      return;
    }
    const m = this.models.get(model);
    if (!m) return;
    const yaw = (g.camYaw / 256 - o.yaw[s]) * TURN, pitch = o.pitch[s] * TURN, roll = o.roll[s] * TURN;
    const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll), Math.sin(roll), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)];
    const n = m.vertexCount;
    const vx = new Float64Array(n), vy = new Float64Array(n), vz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = m.verts[i * 3], y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
      const x1 = x * cr - y * sr, y1 = y * cr + x * sr;
      const z1 = z * cp - y1 * sp, y2 = y1 * cp + z * sp;
      const x2 = x1 * cy - z1 * sy, z2 = z1 * cy + x1 * sy;
      if (i < m.positionCount) { vx[i] = x2 + px; vy[i] = y2 + py; vz[i] = z2 + pz; }
      else { vx[i] = x2; vy[i] = y2; vz[i] = z2; }
    }
    for (const f of m.faces) {
      if (f.idx.length < 3) continue;
      const nv = f.normal;
      let sh = s8(s8((Math.round(vy[nv]) * L[1]) >> 8) + s8((Math.round(vx[nv]) * L[0]) >> 8) + s8((Math.round(vz[nv]) * L[2]) >> 8));
      if (sh < -8) sh = -8;
      const colour = ((f.colour & 0xf0) + sh + 8) & 0xff;
      if (!facing(vx, vy, vz, f.idx)) continue;
      prims.push({ kind: 'poly', colour: this.glow(colour, g), pts: f.idx.map((i) => [vx[i], vy[i], vz[i]]) });
    }
  }
}

/** Back-face test against the eye at (0, 0, -400), in floats. */
function facing(vx, vy, vz, idx) {
  const [v0, v1, v2] = idx;
  const ax = vx[v0] - vx[v1], ay = vy[v0] - vy[v1], az = vz[v0] - vz[v1];
  const bx = vx[v2] - vx[v1], by = vy[v2] - vy[v1], bz = vz[v2] - vz[v1];
  const cx = -vx[v1], cy = -vy[v1], cz = -400 - vz[v1];
  return (az * by - ay * bz) * cx + (ax * bz - az * bx) * cy + (ay * bx - ax * by) * cz >= 0;
}
