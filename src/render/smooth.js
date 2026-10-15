/**
 * In-between frames for the smooth and enhanced modes. The game itself still
 * runs at its 10 frames a second; after each of those frames we keep a copy
 * of what the renderer needs, and a display frame shows a blend of the last
 * two copies. Nothing here touches the game state, so every mode plays the
 * same game. The cost is one game frame (0.1 s) of display latency.
 */
const FIELDS = ['x', 'y', 'z', 'yaw', 'pitch', 'roll'];
const KEEP = ['type', 'model', 'radius'];
const WORD = { x: 1, y: 1, z: 1 };   // 16-bit coordinates; the rest are byte angles

function snapshot(g) {
  const o = {};
  for (const k of FIELDS) o[k] = Float64Array.from(g.o[k].subarray(0, 24), (v, i) => (WORD[k] ? v : v & 0xff));
  for (const k of KEEP) o[k] = Uint16Array.from(g.o[k].subarray(0, 24));
  return {
    o, px: g.p.x, pz: g.p.z, thrust: g.p.thrust,
    camYaw: g.camYaw, camHeight: g.camHeight, terrain: g.terrain, groundColour: g.groundColour ?? 0,
  };
}

const lerpWord = (a, b, t) => { const d = ((b - a + 0x8000) & 0xffff) - 0x8000; return a + d * t; };
const lerpByte = (a, b, t) => { const d = ((b - a + 0x80) & 0xff) - 0x80; return a + d * t; };
const mod = (v, m) => ((v % m) + m) % m;

export class Smoother {
  constructor() { this.prev = null; this.curr = null; this.time = 0; this.period = 100; }

  /** After each game frame, which lasts `period` ms (the enhanced mode's faster game: 20). */
  record(g, now, period = 100) {
    this.period = period;
    this.prev = this.curr ?? snapshot(g);
    this.curr = snapshot(g);
    this.time = now;
  }

  /** After a jump (new round, menu): nothing to blend from. */
  reset() { this.prev = this.curr = null; }

  /**
   * A stand-in for the arena with everything the scene builders read, a
   * fraction `t` of the way from the previous game frame to the latest.
   * `whole` rounds to the integers the original pipeline expects.
   */
  view(t, whole) {
    const a = this.prev, b = this.curr;
    if (!b) return null;
    const r = whole ? Math.round : (v) => v;
    const o = { cell: new Uint16Array(24), vxv: new Uint16Array(24), vyv: new Uint16Array(24), vzv: new Uint16Array(24) };
    for (const k of KEEP) o[k] = b.o[k];
    for (const k of FIELDS) {
      o[k] = new Float64Array(24);
      for (let s = 0; s < 24; s++) {
        const same = a.o.type[s] === b.o.type[s] && (a.o.model[s] & 0xff80) === (b.o.model[s] & 0xff80);
        const far = WORD[k] && Math.abs(((b.o[k][s] - a.o[k][s] + 0x8000) & 0xffff) - 0x8000) > 0x1000;
        const v = !same || far ? b.o[k][s] : WORD[k] ? lerpWord(a.o[k][s], b.o[k][s], t) : lerpByte(a.o[k][s], b.o[k][s], t);
        o[k][s] = mod(r(v), WORD[k] ? 0x10000 : 0x100);
      }
    }
    const jump = Math.abs(((b.px - a.px + 0x8000) & 0xffff) - 0x8000) > 0x1000 || Math.abs(((b.pz - a.pz + 0x8000) & 0xffff) - 0x8000) > 0x1000;
    const tt = jump ? 1 : t;
    const camYaw = mod(lerpWord(a.camYaw, b.camYaw, tt), 0x10000);
    return {
      o,
      p: { x: mod(r(lerpWord(a.px, b.px, tt)), 0x10000), z: mod(r(lerpWord(a.pz, b.pz, tt)), 0x10000), thrust: b.thrust },
      camYaw: whole ? Math.round(camYaw) & 0xffff : camYaw,
      camAngle: (Math.round(camYaw) >> 8) & 0xff,
      camHeight: r(a.camHeight + (b.camHeight - a.camHeight) * tt),
      terrain: b.terrain, groundColour: b.groundColour,
    };
  }
}
