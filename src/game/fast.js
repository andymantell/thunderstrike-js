/**
 * The enhanced mode's faster game. The original runs its whole main loop
 * once every five 50 Hz timer ticks; here the craft, the camera and all
 * movement advance on every tick, a fifth of a game frame at a time, so the
 * controls answer within 20 ms instead of 100.
 *
 * What the original decides once a game frame still happens once every five
 * passes, with Arena's own code: enemy behaviour and its random numbers,
 * waves, timers, power-ups, the round's end. The movement those decisions
 * set (velocities, and the turns and climbs the behaviours make directly) is
 * spread evenly over the five passes, so after each fifth pass the objects
 * stand where the original would have put them. Collisions are tested at
 * those same moments, which keeps the chances of a hit what they were.
 *
 * The craft's own handling (sub_25C1 steering, sub_270C thrust and drag,
 * sub_2558 height, sub_3B72 and sub_3BF0 camera) is worked through in
 * floating point at a fifth of the step, tending to the same speeds.
 *
 * None of this is used by the original modes, which keep Arena.step.
 */
import { u8, s8, u16, s16, imulHi } from '../core/int.js';
import { T, lo, setLo } from './objects.js';
import * as ai from './ai.js';

export const PASSES = 5;            // timer ticks per original game frame
const SLOTS = 24;
const FUEL_MAX = 0x1fff;
const ANGLES = ['yaw', 'pitch', 'roll'];
const WORDS = ['x', 'y', 'z'];
const wrap = (v, m) => ((v % m) + m) % m;
const near = (a, b, m) => wrap(a - b + m / 2, m) - m / 2;    // shortest signed difference

export class FastGame {
  constructor(g) {
    this.g = g;
    this.k = 0;                     // passes made since the last decision
    this.f = null;                  // the craft and camera in floats
    this.written = {};              // what we last wrote back, to notice anything else changing it
    this.spread = {};               // per slot: movement still to hand out this frame
    for (const k of [...WORDS, ...ANGLES]) this.spread[k] = new Int32Array(SLOTS);
    this.follow = new Uint8Array(SLOTS);   // defence pods keep station on the craft
    this.followFrom = { x: new Int32Array(SLOTS), y: new Int32Array(SLOTS), z: new Int32Array(SLOTS) };
    this.typeAt = new Uint16Array(SLOTS);
    this.sinceShot = PASSES;
    this.fire = false;              // a fire press waiting for its turn
    this.thrustLatch = 0;           // thrust presses since the last decision (for turbo)
  }

  /** Start afresh (new game, or switching into this mode). */
  reset() {
    this.f = null; this.k = 0;
    for (const k in this.spread) this.spread[k].fill(0);
    this.follow.fill(0);
    this.fire = false; this.thrustLatch = 0; this.sinceShot = PASSES;
  }

  /** Controls read this pass: presses are kept until they can be used. */
  take(input) {
    if (input.fireLatch) this.fire = true;
    if (input.thrustLatch) this.thrustLatch = 1;
  }

  /** Arena.step, once every PASSES passes: returns the round's end like it. */
  decide() {
    const g = this.g;
    g.frame++;
    const ev = g.checkRoundEnd();       // 1efc
    if (ev) return ev;
    this.finish();
    return null;
  }

  /** Arena.finishFrame without its movement, which move() does. */
  finish() {
    const g = this.g, o = g.o, p = g.p;
    this.sync();
    g.warnings();                                   // 06ff
    if (g.dying === 0) g.spawnWaves();              // 3090
    g.sampleGround();                               // 14ae
    if (!g.dying) {                                 // 2435, the parts that count frames
      o.model[0] = g.craft.model;
      if (g.roundOver) g.autoPilot();
      else if (p.rail) { g.railSteer(); g.railAlign(); }
      g.updateClearance();
      g.input.thrustLatch = this.thrustLatch; this.thrustLatch = 0;
      g.updateTurbo();
      if (!g.roundOver) {
        if (g.input.refuel) p.fuel = FUEL_MAX;
        if (p.rail) this.railSpeed();
      }
      g.sound.stopIfBelow?.(6);
      if (g.groundType === 0x70) { o.model[0] = g.craft.model + 2; g.shield = u16(g.shield - 1); }
    }
    this.behave();
    g.terrain.sinkBunkers();
    g.terrain.rebuildPyramids();
    g.updateThreat();                               // 126b
    this.k = 0;
  }

  /** sub_3231, keeping back what the behaviours moved so move() can hand it out. */
  behave() {
    const g = this.g, o = g.o, p = g.p, sp = this.spread;
    const was = {};
    for (const k of [...WORDS, ...ANGLES]) was[k] = o[k].slice(0, SLOTS);
    const type = o.type.slice(0, SLOTS);
    ai.runAll(g);
    for (let s = 1; s < SLOTS; s++) {
      this.typeAt[s] = o.type[s];
      for (const k in sp) sp[k][s] = 0;
      this.follow[s] = 0;
      if (o.type[s] === 0 || o.type[s] !== type[s]) continue;
      if (o.type[s] === T.DEFENDER) {
        // held as an offset from the craft, which moves in between
        this.follow[s] = 1;
        for (const k of WORDS) {
          const from = s16(was[k][s] - p[k]), to = s16(o[k][s] - p[k]);
          sp[k][s] = to - from;
          this.followFrom[k][s] = from;
        }
      } else {
        for (const k of WORDS) {
          const d = s16(o[k][s] - was[k][s]);
          if (Math.abs(d) > 0x1000) continue;         // a jump, not a movement
          sp[k][s] = d; o[k][s] = was[k][s];
        }
      }
      for (const k of ANGLES) {
        const d = s8(lo(o[k][s]) - lo(was[k][s]));
        sp[k][s] = d; o[k][s] = setLo(o[k][s], lo(was[k][s]));
      }
    }
  }

  /** One pass: a fifth of a frame of movement. */
  move() {
    const g = this.g, o = g.o, p = g.p, N = PASSES, k = this.k;
    const part = (d) => Math.trunc((d * (k + 1)) / N) - Math.trunc((d * k) / N);
    this.sync();
    this.sinceShot++;
    if (!g.dying) {
      g.sampleGround();
      if (!g.roundOver && !p.rail) this.steer();
      this.thrust();
      this.altitude();
      this.write();
      if (this.fire && this.sinceShot >= N) {        // one shot a frame at most, as before
        this.fire = false; this.sinceShot = 0;
        if (!g.roundOver) g.fire();
      }
      o.yaw[0] = setLo(o.yaw[0], p.yaw); o.pitch[0] = setLo(o.pitch[0], p.pitch);
      o.y[0] = p.y; o.x[0] = p.x; o.z[0] = p.z;
    } else this.fire = false;
    this.camera();
    o.roll[0] = setLo(o.roll[0], ((s16(-s16(p.turn)) << 2) >> 8));   // 27c2
    const sp = this.spread;
    for (let s = 0; s < SLOTS; s++) {
      if (s && o.type[s] !== this.typeAt[s]) {     // freed, reused or changed: nothing left to hand out
        for (const key in sp) sp[key][s] = 0;
        this.follow[s] = 0;
        this.typeAt[s] = o.type[s];
      }
      if (this.follow[s]) {
        for (const key of WORDS) {
          const rel = this.followFrom[key][s] + Math.trunc((sp[key][s] * (k + 1)) / N);
          o[key][s] = u16(p[key] + rel);
        }
      } else {
        o.x[s] = u16(o.x[s] + part(s16(o.vx[s])) + part(sp.x[s]));
        o.y[s] = u16(o.y[s] + part(s16(o.vy[s])) + part(sp.y[s]));
        o.z[s] = u16(o.z[s] + part(s16(o.vz[s])) + part(sp.z[s]));
      }
      for (const key of ANGLES) if (sp[key][s]) o[key][s] = setLo(o[key][s], lo(o[key][s]) + part(sp[key][s]));
    }
    this.k = k + 1;
    if (this.k === N) {                            // where the original's frame ends: sub_0002's tests
      g.playerCollisions();
      g.shotCollisions();
    }
  }

  // ------------------------------------------------------------ the craft

  /** Floats from the arena's words, for whatever was changed elsewhere since we wrote them. */
  sync() {
    const g = this.g, p = g.p, w = this.written;
    const fresh = !this.f;
    const f = this.f ??= {};
    if (fresh || p.x !== w.x) f.x = p.x;
    if (fresh || p.z !== w.z) f.z = p.z;
    if (fresh || p.y !== w.y) f.y = s16(p.y);
    if (fresh || p.vx !== w.vx) f.vx = s16(p.vx);
    if (fresh || p.vz !== w.vz) f.vz = s16(p.vz);
    if (fresh || p.yaw !== w.yaw) f.yaw = p.yaw;
    if (fresh || p.thrust !== w.thrust) f.thrust = p.thrust;
    if (fresh || g.camYaw !== w.camYaw) f.camYaw = g.camYaw;
    if (fresh || g.camHeight !== w.camHeight) f.camHeight = s16(g.camHeight);
    if (fresh || g.camClimb !== w.camClimb) f.camClimb = s16(g.camClimb);
  }

  write() {
    const g = this.g, p = g.p, f = this.f, w = this.written;
    f.x = wrap(f.x, 0x10000); f.z = wrap(f.z, 0x10000); f.yaw = wrap(f.yaw, 0x100);
    w.x = p.x = Math.floor(f.x) & 0xffff;
    w.z = p.z = Math.floor(f.z) & 0xffff;
    w.y = p.y = Math.round(f.y) & 0xffff;
    w.vx = p.vx = u16(Math.round(f.vx));
    w.vz = p.vz = u16(Math.round(f.vz));
    w.yaw = p.yaw = Math.floor(f.yaw) & 0xff;
    w.thrust = p.thrust = Math.round(f.thrust) & 0xffff;
  }

  /** sub_26C3's speed along the track; move() makes the movement. */
  railSpeed() {
    const p = this.g.p;
    this.g.sound.request(0x06c8);
    let bx = 0, cx = 0x200;
    if (p.railDir & 0x80) cx = -cx;
    if (p.railDir & 0x40) { const t = cx; cx = bx; bx = t; }
    p.vx = u16(bx); p.vz = u16(cx);
  }

  /** sub_25C1 at a fifth of the turn. */
  steer() {
    const g = this.g, p = g.p;
    const t = g.ds.u8(g.steerCurve + u8(g.input.x));
    const turn = s16(s8(t) * s8(g.craft.turnMul));
    p.turn = u16(turn);
    g.turnIndicator = (turn >> 8) & 0xff;
    this.f.yaw += (turn >> 8) / PASSES;          // the original's whole units a frame, rounded down
  }

  /** sub_270C: thrust builds and fades, and drag acts, a fifth at a time. */
  thrust() {
    const g = this.g, p = g.p, c = g.craft, f = this.f, N = PASSES;
    if (p.rail && !g.roundOver) {                  // sub_26C3: along the track at its fixed speed
      f.vx = s16(p.vx); f.vz = s16(p.vz);
      f.x += f.vx / N; f.z += f.vz / N;
      return;
    }
    let bx;
    if (g.roundOver) bx = c.turboThrust;
    else {
      if (((g.input.buttons | p.turbo) & 1) && s16(p.fuel) >= 0) bx = Math.min(f.thrust + c.accelStep / N, s16(c.maxThrust));
      else bx = Math.max(f.thrust - g.decel / N, 0);
      if (p.turbo) bx = c.turboThrust;
    }
    f.thrust = bx;
    const a = s16(Math.round(bx)), drag = s16(g.drag) / 65536;
    const sin = this.sin(f.yaw), cos = this.sin(f.yaw + 0x40);
    f.vx += ((sin * a) / 65536 - f.vx * drag) / N;
    f.vz += ((cos * a) / 65536 - f.vz * drag) / N;
    f.x += f.vx / N; f.z += f.vz / N;
  }

  /** The original's sine table, read between its entries. */
  sin(a) {
    const t = this.g.tables, i = Math.floor(a), r = a - i;
    return t.sinB(i) * (1 - r) + t.sinB(i + 1) * r;
  }

  /** sub_2558: the height follows the controls; after a round, the climb out goes a fifth at a time. */
  altitude() {
    const g = this.g, p = g.p, f = this.f, N = PASSES;
    let y;
    if (g.roundOver) {
      const want = s16(g.roundOver) >= 0x27 ? f.y + (p.pitch >> 1) / N : 0xb4;
      const d = want - f.y, step = 0x10 / N;
      y = Math.abs(d) > step ? f.y + Math.sign(d) * step : want;
    } else y = (0xc8 - g.input.y) * 2;
    p.ground = g.groundHeight + p.clearance;       // [0x60]
    if (y < p.ground) y = p.ground;
    f.y = y;
    p.vy = 0;
  }

  // ----------------------------------------------------------- the camera

  /** sub_3B72 and sub_3BF0, a fifth of the easing and of the fall each pass. */
  camera() {
    const g = this.g, p = g.p, f = this.f, N = PASSES, tb = g.tables, t = g.terrain;
    // heading: the original moves k/(k+1) of the way a frame
    const n = Math.min(g.radarCount & 0xff, 7), kk = g.ds.u8(0x6616 + n);
    const target = g.cameraTarget() << 8;
    const ease = 1 - Math.pow(kk / (kk + 1), 1 / N);
    f.camYaw = wrap(f.camYaw + near(target, f.camYaw, 0x10000) * ease, 0x10000);
    g.camYaw = Math.round(f.camYaw) & 0xffff;
    g.camAngle = g.camYaw >> 8;
    // height: clear of the land behind the craft, falling under [0x664E] and bouncing
    const cam = g.camAngle, back = u8(cam + 0x80);
    const bx = u16(imulHi(tb.sinB(back), 0x12c0) + p.x);
    const bz = u16(imulHi(tb.cosB(back), 0x12c0) + p.z);
    const side = u8(cam - 0x40), sx = tb.sinB(side) >> 5, sz = tb.cosB(side) >> 5;
    let h = t.heightAt(u16(bx + sx), u16(bz + sz)).height;
    h = Math.max(h, t.heightAt(u16(bx - sx), u16(bz - sz)).height);
    h = Math.max(h, t.heightAt(bx, bz).height);
    const floor = h + 0x28;
    let y = f.camHeight, climb = f.camClimb;
    if (g.roundOver) {
      const d = 0xb4 - y, step = 0x10 / N;
      y = Math.max(Math.abs(d) > step ? y + Math.sign(d) * step : 0xb4, floor);
    } else if (y >= floor) {
      climb -= g.gravity / N;
      y += climb / N;
      if (y < floor) { climb = -climb / 2; y = floor; }
    } else {
      climb -= g.gravity / N;
      const need = floor - y;
      if (need > climb / N) climb = need * N;
      y += climb / N;
      if (climb > 0x3c) climb = 0x3c;
    }
    f.camHeight = y; f.camClimb = climb;
    const w = this.written;
    w.camYaw = g.camYaw;
    w.camHeight = g.camHeight = Math.round(y);
    w.camClimb = g.camClimb = u16(Math.round(climb));
  }
}
