/**
 * The arena simulation. step() is one pass of the original main loop at
 * CS:22C1, which runs at most once every five 50 Hz timer ticks (10 Hz).
 * hudPhase() performs the bookkeeping that the original does while
 * drawing a frame (track lock detection, radar counts, gauges, messages),
 * which matters because later frames read the values it produces.
 *
 * Names are descriptive; comments give the original routine or DS address.
 */
import { u8, s8, u16, s16, imulHi } from '../core/int.js';
import { Objects, T, MAX_OBJECTS, lo, hi, setLo } from './objects.js';
import { Terrain } from './terrain.js';
import { Messages } from './messages.js';
import * as ai from './ai.js';

const SLOTS = 24;              // [0x2C3]
const FUEL_MAX = 0x1fff;
const SHIELD_MAX = 0x1f;

export class Arena {
  constructor(data, sound) {
    this.data = data;
    this.exe = data.exe;
    this.ds = data.exe.ds;
    this.tables = data.tables;
    this.rng = data.rng;
    this.sound = sound;
    this.o = new Objects();
    this.terrain = new Terrain(data);
    this.msg = new Messages(data.exe);
    this.stats = new Stats();
    this.input = { x: 0x80, y: 0x80, buttons: 0, fireLatch: 0, thrustLatch: 0, refuel: false };
    this.craft = { index: 0, speed: 0, accel: 0, turn: 0, model: 0x20, turnMul: 0, maxThrust: 0, turboThrust: 0, accelStep: 0 };
    this.steerCurve = this.ds.u16(0x3e16);
    this.drag = this.ds.u16(0xc2);
    this.decel = this.ds.u16(0xbe);
    this.turboFactor = this.ds.u16(0xc6);
    this.maxEnemies = this.ds.u16(0x4306);
    this.fighterSpeed = this.ds.u16(0x4332);
    this.minerSpeed = this.ds.u16(0x4334);
    this.lungerHp = this.ds.u8(0x4340);
    this.gravity = this.ds.s16(0x664e);
    this.round = 0;
    this.frame = 0;
    this.gauges = { shield: 0xffff, threat: 0xffff };  // [0x8C74],[0x8C78]
    this.radarCount = this.ds.u16(0x195f);            // [0x195F] objects on the scanner last frame
    this.camAngle = this.ds.u8(0x6620);               // [0x6620] camera heading byte, kept apart from [0x6622]
    this.originCol = 0; this.originRow = 0; this.prevOrigin = 0;
  }

  // ------------------------------------------------------------------ craft

  /** sub_2BAB: craft ratings come from DS tables, one word per craft. */
  selectCraft(index) {
    const ds = this.ds, c = this.craft, si = index * 2;
    c.index = index;
    c.turn = ds.u16(0xa6 + si);    // [0xB4]
    c.accel = ds.u16(0x92 + si);   // [0xB0]
    c.speed = ds.u16(0x9c + si);   // [0xB2]
    c.model = si * 2 + 0x20;       // [0xB8]
    this.deriveCraft();
  }

  /** sub_2BD4 */
  deriveCraft() {
    const c = this.craft;
    c.turnMul = Math.floor((0x16 * c.turn + 0x258) / 100);
    c.maxThrust = Math.floor((0x8c * c.speed + 0x4268) / 100) & 0xffff;
    c.turboThrust = (c.maxThrust * this.turboFactor) & 0xffff;
    const div = Math.floor(u16(Math.imul(s16(0xffed), c.accel) + 0x7d0) / 100);
    c.accelStep = Math.floor(c.maxThrust / div) & 0xffff;
  }

  // ------------------------------------------------------------------ setup

  /** sub_297F */
  newGame() {
    this.rng.reset();
    this.strafeSide = 0x40;           // [0x4302]
    this.msg.clear();
    this.round = -1;
    this.dying = 0;                    // [0x15F8]
    this.o.clearAll();
    this.resetPlayerHard();
    this.stats.clearAll();
    this.resetPowerups();
    this.nextRound();
  }

  /** sub_29F5 */
  resetPowerups() {
    this.turbos = 0; this.defenders = 0; this.twinShots = 0; this.powerShots = 0;
    this.threat = 0; this.threatAcc = 0;
  }

  /** sub_2A25 */
  resetPlayerHard() {
    this.o.type[0] = T.PLAYER;
    this.shield = SHIELD_MAX;
    this.p = {
      vx: 0, vy: 0, vz: 0, x: 0, z: 0, y: 0xc8, yaw: 0, pitch: 0, turn: 0, thrust: 0,
      turbo: 0, turboTimer: 0, clearance: 0, ground: 0, fuel: FUEL_MAX, lastThrustLatch: 0,
      rail: 0, railDir: 0x90, railTurned: 0,
    };
    this.camYaw = 0x8000;              // [0x6622]
  }

  /** sub_29A0 */
  nextRound() {
    this.stats.accumulate();            // 130a
    this.waveIndex = 0; this.waveDelay = 0; this.lostTimer = 0; // 2a19
    this.roundOver = 0;                 // [0x38]
    this.round = this.round + 1 === 50 ? 0 : this.round + 1;
    this.arena = Math.floor(this.round / 10);
    this.writeRoundText();
    this.msg.post(0x16, 0x0fcb, 0xffff);
    this.onControllerReset?.();         // call [0x9FFC]: centre the controls
    this.resetPlayerSoft();             // 2a5e
    this.loadRoundTables();             // 2aa3
    this.terrain.loadRound(this.round, this.stats);  // 1ed9 + 1e69
    this.clearEnemies();                // 3040
    this.stats.roundStart(this.round);  // 1361
  }

  /** Patch the round number and arena name into the DS strings like 2AA3 does. */
  writeRoundText() {
    const ds = this.ds, r = this.round;
    const two = [0x30 + Math.floor(r / 10), 0x30 + (r % 10)];
    if (two[0] === 0x30) two[0] = 0x20;
    for (const at of [0x0fd1, 0x1006]) { ds.w8(at, two[0]); ds.w8(at + 1, two[1]); }
    const nameAt = ds.u16(0xae28 + this.arena * 2);
    for (let i = 0; i < 6; i++) ds.w8(0x0fd5 + i, ds.u8(nameAt + i));
    this.groundColour = ds.u8(0xadee + this.arena);   // [0x685B]
  }

  /** sub_2A5E */
  resetPlayerSoft() {
    const p = this.p;
    p.vx = p.vy = p.vz = 0; p.turbo = 0; p.turboTimer = 0;
    p.yaw = 0; p.pitch = 0; p.thrust = 0; p.turn = 0;
    p.y = 0xc8;
    this.camYaw = 0x8000;
    this.camHeight = 0x12c;            // [0x662D]
    this.camClimb = 0xffff;            // [0x662B]
    p.x = 0x8000; p.z = 0x8000;
  }

  /** sub_2AA3 */
  loadRoundTables() {
    const ds = this.ds, r = this.round;
    this.sabotageChance = ds.u8(0xa8d2 + r);   // [0x4336]
    this.sabotageDelay = ds.u8(0xa904 + r);    // [0x4338]
    this.enemyHp = ds.u8(0xa8a0 + r);          // [0x433E]
    this.fireChance = ds.u8(0xa936 + r);       // [0x433A]
    this.waveInterval = ds.u16(0xad8a + r * 2); // [0x4342]
    this.waveTable = [];                       // [0x4351] 4 waves x 5 classes
    for (let i = 0; i < 20; i++) this.waveTable.push(ds.u8(0xa970 + r * 20 + i));
  }

  /** sub_3040 */
  clearEnemies() {
    const o = this.o;
    this.waveDelay = 0; this.enemies = 0;
    for (let s = 0; s < MAX_OBJECTS; s++) {
      if (o.type[s] === T.PLAYER || o.type[s] === T.DEFENDER) continue;
      o.pitch[s] = o.yaw[s] = o.roll[s] = o.type[s] = 0;
      o.vx[s] = o.vy[s] = o.vz[s] = 0;
      o.t1[s] = o.t2[s] = o.link[s] = o.flags[s] = 0;
    }
  }

  /** sub_0685 */
  freeSlot() {
    for (let s = 0; s < SLOTS; s++) if (this.o.type[s] === 0) return s;
    return -1;
  }

  // ------------------------------------------------------------------ frame

  /**
   * Logic half of one frame. Returns 'cleared', 'shutdown' or 'destroyed'
   * when the round ends. After 'cleared' the original shows the results and
   * sets up the next round from inside sub_1EFC, then finishes the frame:
   * the caller does the same and then calls finishFrame().
   */
  step() {
    this.frame++;
    const ev = this.checkRoundEnd();    // 1efc
    if (ev) return ev;
    return this.finishFrame();
  }

  /** The rest of the frame after sub_1EFC. */
  finishFrame() {
    this.warnings();                    // 06ff
    if (this.dying === 0) this.spawnWaves();   // 3090
    this.sampleGround();                // 14ae
    this.updatePlayer();                // 2435
    this.updateCameraYaw();             // 3b72
    this.updateCameraHeight();          // 3bf0
    this.o.roll[0] = setLo(this.o.roll[0], ((s16(-s16(this.p.turn)) << 2) >> 8)); // 27c2
    ai.runAll(this);                    // 3231
    this.moveObjects();                 // 0002
    this.updateThreat();                // 126b
    return null;
  }

  /** sub_1EFC */
  checkRoundEnd() {
    if (this.dying) return this.dying >= 0x14 ? 'destroyed' : null;
    let won = this.roundOver !== 0;
    if (!won) {
      if (this.terrain.bunkersLeft !== 0 || this.enemies !== 0) {
        if (this.terrain.pyramidsLeft !== 0) return null;
        if (!this.lostTimer) this.lostTimer = 0x50;            // [0x1A79]
        return --this.lostTimer === 0 ? 'shutdown' : null;
      }
    }
    this.lostTimer = 0;
    this.roundOver = u16(this.roundOver + 1);
    if (!this.clearTimer) this.clearTimer = 0x50;              // [0x1A7B]
    return --this.clearTimer === 0 ? 'cleared' : null;
  }

  /** sub_0787 + sub_06FF */
  warnings() {
    const fuel = s16(this.p.fuel);
    if (fuel <= 0x7ff) {
      if (fuel > 0x3ff) this.msg.post(0x0804, 0xeb8, 0x32);
      else if (fuel > 0xff) this.msg.post(0x0404, 0xeb8, 0x32);
      else this.msg.post(0x0004, 0xec6, 0x32);
    }
    const sh = s16(this.shield);
    if (sh <= 7) {
      if (sh > 0) this.msg.post(0x8406, 0xed5, 0x32);
      else this.msg.post(0x0006, 0xee5, 0x32);
    }
    if (sh >= 0) return;
    if (this.dying === 0) this.sound.request(0x0c14);
    this.dying++;
    if (this.dying >= 0xf) return;
    const o = this.o, p = this.p;
    p.yaw = u8(p.yaw + 0xf);
    for (let s = 0; s < SLOTS; s++) {
      if (o.type[s] !== T.PLAYER && o.type[s] !== 0) continue;
      o.model[s] = 0x58f0; o.type[s] = T.EXPLOSION;
      o.x[s] = u16(s8(this.rng.next()) * 2 + p.x);
      o.y[s] = p.y;
      o.z[s] = u16(s8(this.rng.next()) * 2 + p.z);
      o.vy[s] = o.vx[s] = o.vz[s] = 0;
      return;
    }
  }

  /** sub_14AE / 1561 */
  sampleGround() {
    const h = this.terrain.heightAt(this.p.x, this.p.z);
    this.groundHeight = h.height;                                  // [0x33C2]
    this.groundCorner = h.cornerA;                                 // [0x33C4]
    this.groundType = this.terrain.typeAt(this.p.x, this.p.z);     // [0x33C0]
  }

  /** sub_2435 */
  updatePlayer() {
    if (this.dying) return;
    const o = this.o, p = this.p;
    o.model[0] = this.craft.model;
    if (this.roundOver) this.autoPilot();
    else if (p.rail) { this.railSteer(); this.railAlign(); }
    else this.steer();
    this.updateClearance();              // 27ec
    this.updateTurbo();                  // 267b
    this.thrust();                       // 270c
    // 26ee: [0x3E18] is never set in this release, so the engine just stops low-id sounds
    this.sound.stopIfBelow?.(6);
    this.altitude();                     // 2558
    if (!this.roundOver && this.input.fireLatch) this.fire();
    if (this.groundType === 0x70) {      // 282b: scraping a bunker pad
      o.model[0] = this.craft.model + 2;
      this.shield = u16(this.shield - 1);
    }
    o.yaw[0] = setLo(o.yaw[0], p.yaw); o.pitch[0] = setLo(o.pitch[0], p.pitch);
    o.y[0] = p.y; o.x[0] = p.x; o.z[0] = p.z;
  }

  /** sub_25C1 */
  steer() {
    const p = this.p;
    const t = this.ds.u8(this.steerCurve + u8(this.input.x));
    const turn = s16(s8(t) * s8(this.craft.turnMul));
    p.turn = u16(turn);
    this.turnIndicator = (turn >> 8) & 0xff;    // [0x2C0]
    p.yaw = u8(p.yaw + (turn >> 8));
  }

  /** sub_24B6 */
  autoPilot() {
    const p = this.p, n = s16(this.roundOver);
    if (n >= 8 && n <= 0x27) { p.turn = (p.turn + 0x200) & 0x3fc0; return; }
    if (n > 0x27) p.pitch = approach(p.pitch, 0x28, 4);
    const r = approach((p.turn >> 6) & 0xff, 0, 8);
    p.turn = (r << 6) & 0xffff;
  }

  /** sub_25FB */
  railSteer() {
    const p = this.p, x = u8(this.input.x);
    this.turnIndicator = x < 0x40 ? 0xff : x < 0xc0 ? 0 : 1;
    if (x < 0x40 || x >= 0xc0) {
      const al = u8(p.railDir + (x >= 0xc0 ? 0x40 : 0xc0));
      const sameCell = ((this.originCol | (this.originRow << 8)) === this.prevOrigin);
      if (!(sameCell && p.railTurned)) {
        if (this.railOpen(al)) { p.railDir = al; p.railTurned = 1; return; }
      } else return;
    }
    if (this.railOpen(p.railDir)) { p.railTurned = 0; return; }
    const cur = p.railDir;
    const left = u8(cur + 0xc0);
    p.railDir = this.railOpen(left) ? left : u8(cur - 0xc0);
    p.railTurned = 1;
  }

  /** sub_2669: can we leave this track cell in direction dir? */
  railOpen(dir) {
    return (this.ds.u8(0x6d + ((u8(dir) >> 6) & 3)) & this.groundType) !== 0;
  }

  /** sub_0E2D: keep centred on the track. */
  railAlign() {
    const p = this.p, key = (p.railDir & 0x40) ? 'z' : 'x';
    const v = p[key], frac = v & 0x3ff, base = v ^ frac;
    if (u16(frac - 0x1c0) <= 0x80) p[key] = base | 0x200;
    else p[key] = u16(frac + (frac < 0x200 ? 0x40 : -0x40)) | base;
    if (p.railDir !== p.yaw) p.yaw = approach(p.yaw, p.railDir, 0x10);
  }

  /** sub_27EC */
  updateClearance() {
    let a = s16(this.p.turn);
    if (a < 0) a = -a;
    let ah = ((a << 2) >> 8) & 0xff;
    if (ah > 0x14) ah = 0x14;
    let bx = (this.groundCorner & 0xf) << 2;
    let dx = this.clearanceBump ?? 0;          // [0x3E1E]
    if (bx < dx) { dx -= 2; if (dx >= 0) bx = dx; }
    this.clearanceBump = bx;
    this.p.clearance = ah + 0x28 + bx;          // [0x5E]
  }

  /** sub_267B: double-tap thrust for a turbo burst. */
  updateTurbo() {
    const p = this.p;
    if (p.turbo) { if (--p.turboTimer === 0) p.turbo = 0; return; }
    if (!this.turbos || p.rail) return;
    const prev = p.lastThrustLatch, now = this.input.thrustLatch;
    p.lastThrustLatch = now;
    if (!prev || !now) return;
    p.turbo = 1; p.turboTimer = 0x1e; this.turbos--;
  }

  /** sub_270C */
  thrust() {
    const p = this.p, c = this.craft, tb = this.tables;
    let bx;
    if (this.roundOver) bx = c.turboThrust;
    else {
      if (this.input.refuel) p.fuel = FUEL_MAX;   // F9 held
      if (p.rail) { this.railMove(); return; }
      if (((this.input.buttons | p.turbo) & 1) && s16(p.fuel) >= 0) {
        bx = u16(p.thrust + c.accelStep);
        if (s16(bx) > s16(c.maxThrust)) bx = c.maxThrust;
      } else {
        bx = s16(p.thrust - this.decel);
        if (bx < 0) bx = 0;
      }
      if (p.turbo) bx = c.turboThrust;
    }
    p.thrust = bx;
    const sin = tb.sinB(p.yaw), cos = tb.cosB(p.yaw);
    p.vx = u16(imulHi(sin, bx) - imulHi(p.vx, this.drag) + s16(p.vx));
    p.x = u16(p.x + p.vx);
    p.vz = u16(imulHi(cos, bx) - imulHi(p.vz, this.drag) + s16(p.vz));
    p.z = u16(p.z + p.vz);
  }

  /** sub_26C3 */
  railMove() {
    const p = this.p;
    this.sound.request(0x06c8);
    let bx = 0, cx = 0x200;
    if (p.railDir & 0x80) cx = -cx;
    if (p.railDir & 0x40) { const t = cx; cx = bx; bx = t; }
    p.vx = u16(bx); p.x = u16(p.x + bx);
    p.vz = u16(cx); p.z = u16(p.z + cx);
  }

  /** sub_2558 / 2500 */
  altitude() {
    const p = this.p;
    let dx;
    if (this.roundOver) {
      let ax = 0xb4;
      if (s16(this.roundOver) >= 0x27) ax = s16(p.y) + (p.pitch >> 1);
      dx = approach16(ax, s16(p.y), 0x10);
    } else {
      dx = (0xc8 - this.input.y) * 2;
    }
    p.ground = this.groundHeight + p.clearance;   // [0x60]
    if (dx < p.ground) dx = p.ground;
    p.y = u16(dx);
    p.vy = 0;
  }

  /** sub_0041 */
  fire() {
    this.sound.request(0x0964);
    this.stats.round.shots++;
    const yaw = this.p.yaw;
    if (this.twinShots === 0) { this.spawnShot(yaw); return; }
    if (--this.twinShots === 0) this.msg.post(0x0a, 0xdff, 0xf);
    this.spawnShot(u8(yaw - 3));
    this.spawnShot(u8(yaw + 3));
  }

  /** sub_00D8 (vy is deliberately left as whatever the slot held) */
  spawnShot(yaw) {
    const s = this.freeSlot();
    if (s < 0) return;
    const o = this.o, p = this.p, tb = this.tables;
    o.x[s] = p.x; o.y[s] = p.y; o.z[s] = p.z;
    o.yaw[s] = setLo(o.yaw[s], yaw);
    o.model[s] = 0x5fec;
    o.damage[s] = setLo(o.damage[s], 1);
    if (this.powerShots) {
      o.model[s] = 0x28ec;
      o.damage[s] = setLo(o.damage[s], 5);
      if (--this.powerShots === 0) this.msg.post(0x08, 0xe15, 0xf);
    }
    o.type[s] = T.SHOT;
    o.t1[s] = setLo(o.t1[s], 0xa);
    o.vx[s] = u16(imulHi(tb.sinB(yaw), 0xbb8));
    o.vz[s] = u16(imulHi(tb.cosB(yaw), 0xbb8));
  }

  /** sub_3B72 */
  updateCameraYaw() {
    let n = this.radarCount & 0xff;
    if (n > 7) n = 7;
    const k = this.ds.u8(0x6616 + n);
    const t = this.cameraTarget();
    const cam = this.camAngle;
    let signed = false;
    if ((cam ^ t) & 0x80) {
      let a = t, b = cam;
      if (!(a & 0x80)) { const x = a; a = b; b = x; }
      signed = s8(a - b) < 0;
    }
    if (!signed) this.camYaw = Math.floor((this.camYaw * k + (t << 8)) / (k + 1)) & 0xffff;
    else this.camYaw = Math.trunc((s16(this.camYaw) * k + s16(t << 8)) / (k + 1)) & 0xffff;
    this.camAngle = this.camYaw >> 8;
  }

  /** sub_3CDE */
  cameraTarget() {
    const p = this.p;
    let d = s16(p.y - this.camHeight);
    if (d < 0) d = -d;
    if (d > 0x1f) return p.yaw;
    const a = 0x1f - d;
    let bl = u8(a + p.yaw);
    if (s8(this.camAngle - p.yaw) < 0) bl = u8(-a + p.yaw);
    return bl;
  }

  /** sub_3BF0 */
  updateCameraHeight() {
    const tb = this.tables, p = this.p, t = this.terrain;
    const cam = this.camAngle;
    const back = u8(cam + 0x80);
    const bx = u16(imulHi(tb.sinB(back), 0x12c0) + p.x);
    const bz = u16(imulHi(tb.cosB(back), 0x12c0) + p.z);
    const side = u8(cam - 0x40);
    const sx = tb.sinB(side) >> 5, sz = tb.cosB(side) >> 5;
    let h = t.heightAt(u16(bx + sx), u16(bz + sz)).height;
    h = Math.max(h, t.heightAt(u16(bx - sx), u16(bz - sz)).height);
    h = Math.max(h, t.heightAt(bx, bz).height);
    const floor = h + 0x28;
    if (this.roundOver) {
      this.camHeight = Math.max(approach16(0xb4, this.camHeight, 0x10), floor);
      return;
    }
    let climb = s16(this.camClimb), y = s16(this.camHeight);
    if (y >= floor) {
      climb -= this.gravity;
      y += climb;
      if (y < floor) { climb = (u16(-climb) >> 1); y = floor; }
      this.camHeight = y; this.camClimb = u16(climb);
      return;
    }
    climb -= this.gravity;
    const need = floor - y;
    if (need > climb) climb = need;
    this.camHeight = y + climb;
    if (climb > 0x3c) climb = 0x3c;
    this.camClimb = u16(climb);
  }

  /** sub_0002 */
  moveObjects() {
    const o = this.o;
    for (let s = 0; s < SLOTS; s++) {
      o.x[s] = u16(o.x[s] + o.vx[s]);
      o.y[s] = u16(o.y[s] + o.vy[s]);
      o.z[s] = u16(o.z[s] + o.vz[s]);
    }
    this.playerCollisions();
    this.shotCollisions();
    this.terrain.sinkBunkers();
    this.terrain.rebuildPyramids();
  }

  /** sub_014D */
  playerCollisions() {
    if (this.dying) return;
    const o = this.o, px = o.x[0], py = o.y[0], pz = o.z[0];
    for (let s = 1; s < SLOTS; s++) {
      if (lo(o.type[s]) < 0x20) continue;
      if (u16(o.x[s] - px + 0x140) > 0x280) continue;
      if (u16(o.y[s] - py + 0x50) > 0xa0) continue;
      if (u16(o.z[s] - pz + 0x140) >= 0x280) continue;
      this.touch(s);
      return;            // the handler's ret leaves sub_014D: one contact per frame
    }
  }

  /** dispatch table DS:0x16A4 */
  touch(s) {
    const o = this.o, t = o.type[s];
    if (t >= 0x40) { this.collectPod(s); return; }
    if (t >= 0x30) {                              // 01e6 / 01eb
      if (t === T.SABOTEUR) this.releasePyramid(s);
      this.sound.request(0x0e14);
      o.type[s] = T.EXPLOSION; o.model[s] = 0x58f0;
      o.vx[s] = o.vy[s] = o.vz[s] = 0;
      this.p.vx = u16(-s16(this.p.vx));
      this.p.vz = u16(-s16(this.p.vz));
      this.enemies = u16(this.enemies - 1);
      if (this.loseShield(8)) return;
    } else {                                      // 01ac: shots and shrapnel
      this.sound.request(0x0e14);
      o.type[s] = T.SMALL_EXPLOSION; o.model[s] = 0x58f0;
      o.vx[s] = o.vy[s] = o.vz[s] = 0;
      if (this.loseShield(4)) return;
    }
    o.model[0] = this.craft.model + 2;            // 0230
    this.typeMessage(t);                          // 0239
  }

  /** Returns true when this hit used up the shield (01DF/022A then return at once). */
  loseShield(n) {
    const sh = s16(this.shield);
    if (sh < 0) return false;
    const v = sh - n;
    if (v >= 0) { this.shield = v; return false; }
    this.shield = 0xffff;
    return true;
  }

  /** 0x0239: per-type message from DS:0x174A */
  typeMessage(type) {
    const bp = this.ds.u16(0x174a + type * 2);
    if (bp) this.msg.post(0x0e, bp, 0xf);
  }

  /** pod handlers 0x2A6.. then 0x2AC */
  collectPod(s) {
    const o = this.o, t = o.type[s];
    switch (t) {
      case T.POD_SHIELD: this.rechargeShield(); break;
      case T.POD_DEFENCE: this.installDefender(); break;
      case T.POD_TWIN: this.twinShots = 0x3c; break;
      case T.POD_POWER: this.powerShots = 0x50; break;
      case T.POD_TURBO: this.turbos = 4; break;
      default: this.p.fuel = FUEL_MAX; break;     // fuel pod and 0x46..0x4F
    }
    this.sound.request(0x161e);
    o.type[s] = 0; o.vx[s] = 0; o.vz[s] = 0;
    this.typeMessage(t);
  }

  /** sub_0273 */
  rechargeShield() {
    this.msg.post(0x06, 0xef6, 0xf);
    let v = u16(this.shield + 6);
    if (v > SHIELD_MAX) v = SHIELD_MAX;
    this.shield = v;
  }

  /** sub_02C7 */
  installDefender() {
    if (this.defenders >= 3) { this.msg.post(0x12, 0xf77, 0xf); return; }
    const s = this.freeSlot();
    if (s < 0) return;
    this.o.type[s] = T.DEFENDER;
    this.o.model[s] = 0x4fec;
    this.defenders++;
    this.msg.post(0x12, 0xf8c, 0xf);
  }

  /** sub_10F2 */
  defenderLost() {
    if (--this.defenders === 0) this.msg.post(0x12, 0xfb5, 0xa);
  }

  /** sub_0648 */
  releasePyramid(s) {
    const o = this.o;
    if (hi(o.t1[s]) === 0xff) this.terrain.pyramids[o.link[s] >> 1].timer = 0x96;
  }

  /** sub_02F9 */
  shotCollisions() {
    const o = this.o, shots = [], targets = [];
    for (let s = 1; s < SLOTS; s++) {
      const t = o.type[s];
      if (t >= 0x30) targets.push(s);
      else if ((t & 0xfff0) === 0x10) shots.push(s);
    }
    for (const d of shots) {
      let hit = false;
      for (const s of targets) {
        if (lo(o.type[s]) === 0) continue;
        if (Math.abs(s16(o.x[d] - o.x[s])) > 0x1b8) continue;
        if (Math.abs(s16(o.z[d] - o.z[s])) > 0x1b8) continue;
        if (Math.abs(s16(o.y[d] - o.y[s])) > 0x6e) continue;
        this.shotHits(d, s);
        hit = true;
        break;
      }
      if (!hit) this.shotGround(d);
    }
  }

  /** sub_03A7 */
  shotGround(d) {
    const o = this.o;
    if (s16(o.y[d]) >= 0xd0) return;
    const cell = this.terrain.cellAt(o.x[d], o.z[d]);
    if ((this.terrain.map[0x1000 + cell] & 0xf0) !== 0x70) return;
    if (o.type[d] === T.DEFENDER) this.defenderLost();
    this.stats.round.hits++;
    o.type[d] = T.EXPLOSION; o.model[d] = 0x58f0;
    o.vx[d] = o.vy[d] = o.vz[d] = 0;
    const b = this.terrain.bunkerAtCell(cell);
    if (b < 0) return;
    this.sound.request(0x103c);
    this.lastBunkerHit = b;                       // [0x15F6]
    this.terrain.damageBunker(b, lo(o.damage[d]), () => this.sound.request(0x0c14));
  }

  /** sub_0465: dispatch table DS:0x1604 */
  shotHits(d, s) {
    const o = this.o, t = o.type[s];
    // DS:0x1604 sends explosions (0554) and pods (05B9) to a bare return: the shot passes through
    if ((t >= 0x08 && t <= 0x0f) || t >= 0x40) return;
    let kill;
    if (t === T.FIGHTER || t === T.GLIDER || t === T.MINER) kill = this.wound(s, d);
    else if (t === T.SABOTEUR) { kill = this.wound(s, d); if (kill) this.releasePyramid(s); }
    else if (t === T.LUNGER) { kill = this.wound(s, d); if (kill) this.shatter(s); }
    else {                                         // 0557
      const hp = u8(lo(o.hp[s]) - 1);
      o.hp[s] = setLo(o.hp[s], hp);
      kill = hp === 0;
    }
    if (kill) this.kill(s);
    // 0472: the shot is spent
    if (o.type[d] === T.DEFENDER) this.defenderLost();
    else this.stats.round.hits++;
    o.vx[d] = 0; o.vz[d] = 0;
    o.type[d] = setLo(o.type[d], T.SMALL_EXPLOSION);
    o.model[d] = 0x58f0;
  }

  /** sub_05BC */
  wound(s, d) {
    const o = this.o;
    o.flags[s] |= 2;
    const hp = s8(lo(o.hp[s]) - lo(o.damage[d]));
    o.hp[s] = setLo(o.hp[s], hp);
    return hp <= 0;
  }

  /** sub_055D */
  kill(s) {
    const o = this.o;
    this.sound.request(0x103c);
    this.threatBonus = u16((this.threatBonus ?? 0) + 0x600);   // [0x19F5]
    if (this.rng.next() >= 0x50) {
      o.type[s] = T.EXPLOSION; o.model[s] = 0x58f0;
    } else {
      o.type[s] = this.ds.u8(0x17ec + (this.rng.next() & 7));
      o.model[s] = 0;
      o.vx[s] = o.vy[s] = o.vz[s] = 0;
      o.pitch[s] = 0; o.roll[s] = 0;
      o.link[s] = 0xffff;
    }
    this.enemies = u16(this.enemies - 1);
  }

  /** 0x05E0: a lunger bursts into six fragments */
  shatter(s) {
    const o = this.o, x = o.x[s], y = o.y[s], z = o.z[s];
    let dir = 0;
    for (let i = 0; i < 6; i++) {
      const n = this.freeSlot();
      if (n < 0) return;
      o.x[n] = x; o.z[n] = z; o.y[n] = y;
      o.model[n] = 0x5fec; o.type[n] = T.SHRAPNEL;
      o.t1[n] = setLo(o.t1[n], 0xa);
      o.vx[n] = u16(imulHi(this.tables.sinB(dir), 0x7d0));
      o.vz[n] = u16(imulHi(this.tables.cosB(dir), 0x7d0));
      dir = u8(dir + 0x2a);
    }
  }

  /** sub_3090 */
  spawnWaves() {
    const d = s16(this.waveDelay);
    if (d > 0) { this.waveDelay--; return; }
    if (d === 0) {
      const base = (this.waveIndex & 3) * 5;
      this.pending = this.waveTable.slice(base, base + 5);               // [0x4346]
      this.waveRemaining = this.pending.reduce((a, b) => a + b, 0);      // [0x434F]
      this.waveDelay = 0xffff;
      this.waveIndex++;
      return;
    }
    // 30D5: walk the bunker arrays. sub_066D (free slot) leaves CX = slots
    // left to search, and that becomes this loop's counter, so the walk is
    // not limited to the live bunkers and can launch from stale entries.
    const t = this.terrain;
    let b = 0, cx = 0;
    for (;;) {
      if (this.enemies >= this.maxEnemies) return;
      const s = this.freeSlotBelow(SLOTS - 8);
      if (s < 0) return;
      cx = SLOTS - 8 - s;
      for (;;) {
        const bk = t.bunker(b);
        if (s16(bk.health) > 0 && !bk.cooldown) break;
        b++;
        cx = (cx - 1) & 0xffff;
        if (cx === 0) return;
      }
      this.launch(b, s);
      if (--this.waveRemaining === 0) { this.waveDelay = this.waveInterval; return; }
      b++;
      cx = (cx - 1) & 0xffff;
      if (cx === 0) return;
    }
  }

  /** sub_066D */
  freeSlotBelow(limit) {
    for (let s = 0; s < limit; s++) if (this.o.type[s] === 0) return s;
    return -1;
  }

  /** sub_3125 */
  launch(b, s) {
    const o = this.o, t = this.terrain;
    const bk = t.bunker(b);
    bk.cooldown = 0x14;
    let ax = (bk.spawnCell << 2) & 0xffff;
    ax = (ax & 0xff) | ((((ax >> 8) << 2) & 0xff) << 8);
    o.x[s] = u16(((ax & 0xff) << 8) - 0x200);
    o.y[s] = 0x118;
    o.z[s] = u16(((((ax >> 8) + 0x44) & 0xff) << 8) - 0x200);
    o.vx[s] = o.vy[s] = o.vz[s] = 0;
    o.pitch[s] = o.yaw[s] = o.roll[s] = 0;
    o.t2[s] = 0; o.link[s] = 0;
    o.t1[s] = 0x000a;
    o.flags[s] = 1;
    this.enemies++;
    let k = 0;
    while (this.pending[k] === 0) k++;
    this.pending[k]--;
    o.type[s] = [ai.spawnSaboteur, ai.spawnFighter, ai.spawnGlider, ai.spawnMiner, ai.spawnLunger][k](this, s);
  }

  /** sub_126B */
  updateThreat() {
    let al = s8((this.gauges.shield & 0xff) + 0xff);
    if (al < 0) al = 0;
    const level = ((0x3f - al) & 0xff) >> 1;               // [0x19F1]
    const radar = u16(this.radarCount << 1);               // [0x19F3]
    let bonus = this.threatBonus ?? 0;
    if (bonus) { bonus = u16(bonus - 0x20); if (s16(bonus) > 0x2800) bonus = 0x2800; }
    this.threatBonus = bonus;
    const turbo = (this.p.turbo & 1) ? 4 : 0;
    let bx = s16((level >> 2) + radar + ((bonus >> 8) & 0xff) + turbo);
    if (bx > 0x1f) bx = 0x1f;
    if (bx < s16(this.threat)) {
      this.threatAcc = u16(this.threatAcc - 1);
      this.threat = s16(this.threatAcc) >> 4;
      return;
    }
    this.threat = bx;
    this.stats.round.vid += bx; this.stats.round.vidMax += 0x20;
    this.threatAcc = u16(bx << 4);
  }

  // ---------------------------------------------------------- frame-side

  /**
   * Work the original does while drawing (sub_1BFA origin, sub_0DC8 track
   * lock, gauges, radar counts, messages). Returns HUD state for drawing.
   */
  hudPhase() {
    // 1bfa: terrain window origin
    this.prevOrigin = this.originCol | (this.originRow << 8);
    this.originCol = ((this.p.x >> 10) - 8) & 0x3f;
    this.originRow = ((this.p.z >> 10) - 8) & 0x3f;
    this.trackLock();                                   // 0dc8
    this.saboteursActive = 0;
    return null;
  }

  /** sub_0DC8 */
  trackLock() {
    const p = this.p;
    if (p.y !== p.ground || this.groundType >= 0x10) { p.rail = 0; this.railDecay = 0x100; return; }
    if (!p.rail) {
      const al = u8(p.yaw + 0x20) & 0xc0;
      if (!this.railOpen(al)) return;
      p.railDir = al; p.rail = 1;
      return;
    }
    let ax = s16(p.turn);
    if (ax === 0) { p.turn = 0; return; }
    let bx = this.railDecay;
    if (ax > 0) bx = -bx;
    const n = ax + bx;
    if ((n ^ ax) < 0) this.railDecay >>= 1;
    p.turn = u16(n);
  }
}

/** sub_3997: turn byte angle `cur` towards `want` by at most `step`. */
export function approach(cur, want, step) {
  const d = s8(want - cur);
  if (d >= 0) return d < step ? u8(want) : u8(cur + step);
  return d > -step ? u8(want) : u8(cur - step);
}

/** sub_2540 */
export function approach16(target, cur, step) {
  const d = target - cur;
  if (Math.abs(d) > step) return cur + (d < 0 ? -step : step);
  return target;
}

/** Hit / defence / video rate accounting (DS:0x1A0F onwards). */
export class Stats {
  constructor() { this.clearAll(); }
  blank() { return { hits: 0, shots: 0, def: 0, defMax: 0, vid: 0, vidMax: 0 }; }
  clearAll() { this.round = this.blank(); this.arena = this.blank(); this.game = this.blank(); }
  pyramidsPlaced(n) { this.round.def += n; this.round.defMax += n; }
  pyramidLost() { this.round.def--; }
  accumulate() {
    for (const k of Object.keys(this.round)) { this.arena[k] += this.round[k]; this.game[k] += this.round[k]; this.round[k] = 0; }
  }
  roundStart(r) { if (r % 10 === 0) this.arena = this.blank(); }
  /** sub_1426: per-mille ratio a/b using the original's normalisation. */
  static rate(a, b) {
    if (!b) return 0;
    while (((a | b) >>> 0) < 0x80000000 && b < 0x80000000) { a *= 2; b *= 2; if (a >= 0x80000000 || b >= 0x80000000) break; }
    const ah = Math.floor(a / 65536), bh = Math.floor(b / 65536);
    return bh ? Math.floor((ah * 1000) / bh) : 0;
  }
}
