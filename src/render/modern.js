/**
 * Enhanced rendering: the scene SceneBuilder draws (terrain, objects and
 * their colours), worked out in floating point and handed to three.js as
 * view-space polygons, so the GPU draws it with perspective and a depth
 * buffer at screen resolution, with the terrain reaching three times as far.
 * Angles may be fractional, which is what the in-between frames of the
 * smooth modes need.
 *
 * View space is the original's: x and z in quarter world units, y in world
 * units, the eye 400 units behind the screen plane.
 */
import { SceneBuilder } from './scene.js';
import { s8, u8 } from '../core/int.js';

const TURN = (2 * Math.PI) / 256;   // radians per angle unit (bytes)
const WINDOW = 48;                  // terrain cells across (the original: 16)
const wrap16 = (v) => ((v % 65536) + 98304) % 65536 - 32768;   // signed 16-bit difference, kept fractional

export class ModernSceneBuilder extends SceneBuilder {
  /**
   * The terrain around the craft in view space. The original keeps a 16x16
   * window; here it is WINDOW cells across (the 64x64 map wraps, so more
   * than 64 would repeat), so the land reaches much further.
   */
  buildGrid(g) {
    const map = g.terrain.map, N = WINDOW + 1, half = WINDOW / 2;
    const a = (g.camYaw / 256) * TURN, sin = Math.sin(a), cos = Math.cos(a);
    const col0 = ((Math.floor(g.p.x) >> 10) - half) & 0x3f;
    // map rows run the other way from Z; row = (Z >> 10) - 16, as in the original's window
    const row0 = ((Math.floor(g.p.z) >> 10) - 16 + half) & 0x3f;
    const fx = (g.p.x / 4) % 256, fz = (g.p.z / 4) % 256;
    this.N = N;
    this.vx = new Float32Array(N * N); this.vy = new Float32Array(N * N); this.vz = new Float32Array(N * N);
    this.cellB = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) {
      const dz = half * 0x100 - fz - j * 0x100, row = (row0 - j) & 0x3f;
      for (let i = 0; i < N; i++) {
        const k = j * N + i, dx = -half * 0x100 - fx + i * 0x100, cell = (row << 6) | ((col0 + i) & 0x3f);
        this.vx[k] = dx * cos - dz * sin;
        this.vz[k] = dx * sin + dz * cos;
        this.vy[k] = (map[cell] & 0xf0) - g.camHeight;
        this.cellB[k] = map[0x1000 + cell];
      }
    }
  }

  /** Every object within the window, in view space (fx, fy, fz). */
  buildObjects(g) {
    const o = g.o, reach = (WINDOW / 2) * 0x400;
    const a = (g.camYaw / 256) * TURN, sin = Math.sin(a), cos = Math.cos(a);
    this.fx = new Float64Array(24); this.fy = new Float64Array(24); this.fz = new Float64Array(24);
    this.objects = [];
    for (let s = 0; s < 24; s++) {
      if (o.type[s] === 0) continue;
      const dx = wrap16(o.x[s] - g.p.x), dz = wrap16(o.z[s] - g.p.z);
      if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
      this.fx[s] = (dx * cos - dz * sin) / 4; this.fy[s] = o.y[s] - g.camHeight; this.fz[s] = (dx * sin + dz * cos) / 4;
      if (this.fz[s] < -400) continue;   // behind the eye
      this.objects.push(s);
    }
  }

  /** The scene for a depth-buffered draw: all terrain cells, then the objects. */
  build(g) {
    this.buildGrid(g);
    this.buildObjects(g);
    const L = this.light(g.camAngle);
    this.animIndex = (this.animIndex + 1) & 0xf;
    const anim = this.ds.u8(0x33b0 + this.animIndex);
    const prims = [];
    const N = this.N;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const A = j * N + i, B = A + 1, C = A + N + 1, D = A + N;
        // the original takes the colour from the corner after A (k + 1)
        const raw = this.cellB[B];
        let colour = raw & 0x7f;
        if (colour < 0x10) colour = 0;
        if (colour >= 0x70) colour = anim;
        const P = (k) => [this.vx[k], this.vy[k], this.vz[k]];
        if (Math.max(this.vz[A], this.vz[B], this.vz[C], this.vz[D]) < -390) continue;
        const poly = (...pts) => prims.push({ kind: 'poly', colour, pts });
        if (!(raw & 0x80)) poly(P(A), P(B), P(C), P(D));
        else if (this.vy[A] !== this.vy[C]) { poly(P(A), P(B), P(C)); poly(P(A), P(C), P(D)); }
        else { poly(P(A), P(B), P(D)); poly(P(B), P(C), P(D)); }
      }
    }
    for (const s of this.objects) this.object(g, s, L, prims);
    return prims;
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
