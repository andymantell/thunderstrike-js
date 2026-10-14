/**
 * Object behaviours (dispatch table DS:0x4377, driven by sub_3231 for the
 * first 24 slots). Each function is named after what the object does and
 * annotated with its original address.
 */
import { u8, s8, u16, s16, imulHi } from '../core/int.js';
import { T, lo, hi, setLo, setHi } from './objects.js';
import { approach } from './arena.js';

export function runAll(g) {
  const o = g.o;
  g.attackers = 0;          // [0x433C]
  g.attackAngle = 0;        // [0x433D]
  g.podLabels = [];         // list at DS:0x19BB
  for (let s = 0; s < 24; s++) {
    if (o.flags[s] & 1) {   // still rising out of its bunker
      o.yaw[s] = setLo(o.yaw[s], lo(o.yaw[s]) + 0x13);
      const t = u8(lo(o.t1[s]) - 1);
      o.t1[s] = setLo(o.t1[s], t);
      if (t === 0) o.flags[s] &= 0xfffe;
      continue;
    }
    const type = lo(o.type[s]);
    const fn = BEHAVIOUR[type] ?? (type >= 0x40 ? pod : type <= 0x0f ? idle : expire);
    fn(g, s);
  }
  g.attackInfo = g.attackers | (g.attackAngle << 8);  // [0x17FC]
}

// ---------------------------------------------------------------- helpers

/** sub_32D6/397B: angle from object to (x,z) and the Manhattan distance. */
function towards(g, s, x, z) {
  const dx = s16(x - g.o.x[s]), dz = s16(z - g.o.z[s]);
  const dist = (Math.abs(dx) + Math.abs(dz)) & 0xffff;
  return { angle: g.tables.atan2(dx, dz), dist };
}
const towardsPlayer = (g, s) => towards(g, s, g.p.x, g.p.z);

/** sub_3958: is `angle` within +-range of `facing`? (true = within) */
function facing(angle, yaw, range) {
  return u8(angle - yaw + range) <= u8(range << 1);
}

/** sub_39B0 (bx != 0): accelerate along `angle` with drag [0xC2]. */
function thrustAlong(g, s, angle, power) {
  const o = g.o, tb = g.tables, drag = g.drag;
  if (!power) { dragOnly(g, s); return; }
  o.vx[s] = u16(imulHi(tb.sinB(angle), power) - imulHi(o.vx[s], drag) + s16(o.vx[s]));
  o.vz[s] = u16(imulHi(tb.cosB(angle), power) - imulHi(o.vz[s], drag) + s16(o.vz[s]));
}
/** sub_39EC */
function dragOnly(g, s) {
  const o = g.o, drag = g.drag;
  if (o.vx[s]) o.vx[s] = u16(s16(o.vx[s]) - imulHi(o.vx[s], drag));
  if (o.vz[s]) o.vz[s] = u16(s16(o.vz[s]) - imulHi(o.vz[s], drag));
}
/** sub_3AC2 / 3B3D: set velocity along angle. */
function velocityAlong(g, s, angle, speed) {
  g.o.vx[s] = u16(imulHi(g.tables.sinB(angle), speed));
  g.o.vz[s] = u16(imulHi(g.tables.cosB(angle), speed));
}
/** sub_3933/3936: climb or dive towards a height by at most `step`. */
function heightTowards(g, s, target, step) {
  const o = g.o, cur = s16(o.y[s]);
  let d = s16(target - cur), st = step;
  if (d < 0) { d = -d; st = -st; }
  o.y[s] = u16(d > step ? cur + st : target);
}
/** sub_391F: keep at least `clear` above the terrain. */
function keepClear(g, s, clear) {
  const h = g.terrain.heightAt(g.o.x[s], g.o.z[s]).height + clear;
  if (h > s16(g.o.y[s])) g.o.y[s] = h;
}
/** sub_327B: show the "hit" model for one frame after being shot. */
function hitFlash(g, s, model) {
  if (g.o.flags[s] & 2) { g.o.model[s] = model; g.o.flags[s] &= 0xfffd; }
}

/** sub_3A66: fire a shot forwards with probability chance/256. */
function shoot(g, s, chance) {
  if (g.rng.next() >= chance) return;
  dropShot(g, s, lo(g.o.yaw[s]), 0xa, 0xbb8);
}
/** sub_3ADA: drop a mine behind. */
function dropMine(g, s, chance) {
  if (g.rng.next() >= chance) return;
  dropShot(g, s, u8(lo(g.o.yaw[s]) + 0x80), 0x28, 0x190);
}
function dropShot(g, s, dir, life, speed) {
  const o = g.o;
  const d = g.freeSlot();
  if (d < 0) return;
  g.sound.request(0x0a64);
  o.x[d] = o.x[s]; o.y[d] = o.y[s]; o.z[d] = o.z[s];
  o.yaw[d] = setLo(o.yaw[d], dir);
  o.model[d] = 0x1ff0;
  o.type[d] = T.ENEMY_SHOT;
  o.t1[d] = setLo(o.t1[d], life);
  velocityAlong(g, d, dir, speed);
}

// ------------------------------------------------------------- spawners

/** class table DS:0x436D, each returns the new object type */
export function spawnSaboteur(g, s) { g.o.hp[s] = g.enemyHp; g.o.model[s] = 2; return T.SABOTEUR; }
export function spawnFighter(g, s) { g.o.hp[s] = g.enemyHp; g.o.model[s] = 0x10; return T.FIGHTER; }
export function spawnGlider(g, s) { g.o.hp[s] = g.enemyHp; g.o.model[s] = 8; return T.GLIDER; }
export function spawnMiner(g, s) { g.o.hp[s] = g.enemyHp; g.o.model[s] = 0x34; return T.MINER; }
export function spawnLunger(g, s) { g.o.hp[s] = g.lungerHp; g.o.model[s] = 0x38; return T.LUNGER; }

// ------------------------------------------------------------ behaviours

function idle() {}                                   // 0x35D4

/** 0x35D5: shots and other short-lived objects. */
function expire(g, s) {
  const o = g.o;
  const t = u8(lo(o.t1[s]) - 1);
  o.t1[s] = setLo(o.t1[s], t);
  if (t === 0) { o.type[s] = 0; o.vx[s] = 0; o.vz[s] = 0; }
}

/** 0x3598: debris cloud, seven frames. */
function explosion(g, s) {
  const o = g.o;
  let m = o.model[s];
  let al = u8(-lo(m) + 0x10) & 0x7f;
  if (al === 0) { o.type[s] = setLo(o.type[s], 0); return; }
  al = u8(-al);
  m = ((u8(hi(m) + 1) << 8) | al) ^ 0x7700;
  o.model[s] = m & 0xffff;
}
/** 0x35B6: short flash. */
function smallExplosion(g, s) {
  const o = g.o;
  let m = o.model[s];
  let al = u8(-lo(m) + 7);
  if (al > 0x28) { o.type[s] = setLo(o.type[s], 0); return; }
  al = u8(-al);
  o.model[s] = (((u8(hi(m) + 1) << 8) | al) ^ 0x7700) & 0xffff;
}

/** 0x35EE: lunger shrapnel homes in on the player's height. */
function shrapnel(g, s) {
  heightTowards(g, s, s16(g.p.y), 0x14);
  g.o.model[s] = 0x1ff0;
  expire(g, s);
}

/** 0x36D0: defence pod circling the craft. */
function defender(g, s) {
  const o = g.o, tb = g.tables, p = g.p;
  const a = u8(lo(o.yaw[s]) + 0x14);
  o.yaw[s] = setLo(o.yaw[s], a);
  const r = imulHi(tb.sinB(a), 0x2580);
  o.z[s] = u16((imulHi(tb.cosB(a), 0x2580) >> 2) + p.z);
  const b = u8(lo(o.roll[s]) + 3);
  o.roll[s] = setLo(o.roll[s], b);
  o.x[s] = u16(imulHi(tb.cosB(b), r) + p.x);
  o.y[s] = u16((s16(-imulHi(tb.sinB(b), r)) >> 2) + p.y);
  o.vx[s] = o.vy[s] = o.vz[s] = 0;
}

/** 0x3738: something falling towards the player (type 0x30). */
function falling(g, s) {
  const o = g.o;
  const a = g.tables.atan2(s16(g.p.x - o.x[s]), s16(g.p.z - o.z[s]));
  velocityAlong(g, s, a, 0x4b0);
  o.vy[s] = u16(o.vy[s] - o.link[s]);
  if (s16(o.y[s]) < 0xc8) { o.vy[s] = 0; o.type[s] = 0; }
}

/** 0x3310: fighter. */
function fighter(g, s) {
  const o = g.o;
  if (g.rng.next() <= 8) g.terrain.saboteurRandom ^= 0x80; // [0x4302] strafe side
  const { angle, dist } = towardsPlayer(g, s);
  g.targetAngle = angle;                       // [0x4300]
  let dodge = false;
  if (dist <= 0x2000 && facing(angle, lo(o.yaw[s]), 0x14)) {
    shoot(g, s, g.fireChance);
    if (dist < 0xc00) dodge = true;
  }
  if (!dodge) {
    if (dist <= 0x1400) {
      g.attackers++; g.attackAngle = angle;
      if (lo(o.t1[s]) !== 0) dodge = true;
    }
  }
  if (dodge) {
    o.t1[s] = setLo(o.t1[s], 0xff);
    o.yaw[s] = setLo(o.yaw[s], approach(lo(o.yaw[s]), u8(angle + g.terrain.saboteurRandom), 0x10));
  } else {
    o.t1[s] = setLo(o.t1[s], 0);
    o.yaw[s] = setLo(o.yaw[s], approach(lo(o.yaw[s]), angle, 0x10));
  }
  o.model[s] = 0x14;                            // 328c
  thrustAlong(g, s, lo(o.yaw[s]), g.fighterSpeed);
  heightTowards(g, s, s16(g.p.y), 0xa);
  keepClear(g, s, 0x3c);
  hitFlash(g, s, 0x12);
}

/** 0x3823: glider, banks randomly and fires when lined up. */
function glider(g, s) {
  const o = g.o;
  o.model[s] = setLo(o.model[s], 8);
  let t = s8(lo(o.t1[s]) - 1);
  o.t1[s] = setLo(o.t1[s], t);
  if (t < 0) {
    o.t1[s] = setLo(o.t1[s], (g.rng.next() & 0x1f) + 0x14);
    o.t2[s] = setHi(o.t2[s], u8((g.rng.next() & 0x1f) - 0xf));
  }
  let bank = s8(hi(o.t1[s]));
  const want = s8(hi(o.t2[s]));
  if (bank !== want) bank += bank < want ? 1 : -1;
  o.t1[s] = setHi(o.t1[s], bank);
  o.roll[s] = setLo(o.roll[s], bank);
  const yaw = u8(lo(o.yaw[s]) + (s8(-bank) >> 2));
  o.yaw[s] = setLo(o.yaw[s], yaw);
  velocityAlong(g, s, yaw, 0x258);
  const angle = g.tables.atan2(s16(g.p.x - o.x[s]), s16(g.p.z - o.z[s]));
  if (facing(angle, yaw, 0x14)) {
    if (g.terrain.bunkersLeft === 0) o.t2[s] = setHi(o.t2[s], 0);
    const dist = (Math.abs(s16(g.p.x - o.x[s])) + Math.abs(s16(g.p.z - o.z[s]))) & 0xffff;
    if (dist <= 0x1800) {
      shoot(g, s, 0x20);
      heightTowards(g, s, s16(g.p.y), 0xa);
    }
  }
  keepClear(g, s, 0x3c);
  hitFlash(g, s, 0xa);
}

/** 0x33CB: miner lays mines behind it and runs away when close. */
function miner(g, s) {
  const o = g.o;
  o.model[s] = 0x34;
  let { angle, dist } = towardsPlayer(g, s);
  if (dist <= 0x2000) {
    dropMine(g, s, 0x20);
    if (dist <= 0xc00) o.t1[s] = setHi(o.t1[s], 0x78);
  }
  if (hi(o.t1[s])) {
    o.t1[s] = setHi(o.t1[s], hi(o.t1[s]) - 1);
    angle = u8(angle + 0x80);
  }
  const yaw = approach(lo(o.yaw[s]), angle, 0x20);
  o.yaw[s] = setLo(o.yaw[s], yaw);
  thrustAlong(g, s, yaw, g.minerSpeed);
  heightTowards(g, s, s16(g.p.y), 0xa);
  keepClear(g, s, 0x3c);
  hitFlash(g, s, 0x36);
}

/** 0x3421: lunger spins, then charges in straight lines. */
function lunger(g, s) {
  const o = g.o;
  o.pitch[s] = setLo(o.pitch[s], lo(o.pitch[s]) + 6);
  o.roll[s] = setLo(o.roll[s], lo(o.roll[s]) + 0xa);
  let al = u8(lo(o.t1[s]) + 1);
  let drift = false;
  if (al === 0) {
    const { angle, dist } = towardsPlayer(g, s);
    if (dist >= 0x1400 && g.terrain.bunkersLeft !== 0) {
      o.vx[s] = 0x28; o.vz[s] = 0x28;
      drift = true;
    } else {
      o.yaw[s] = setLo(o.yaw[s], angle);
      heightTowards(g, s, s16(g.p.y), 0x14);
      al = 0;
    }
  }
  if (!drift) {
    if (al === 0x1e) al = 0xff;
    o.t1[s] = setLo(o.t1[s], al);
    velocityAlong(g, s, lo(o.yaw[s]), 0x320);
  }
  keepClear(g, s, 0x3c);
  o.model[s] = 0x38;
  hitFlash(g, s, 0x3a);
}

/** 0x3485: saboteur flies to a pyramid, sits on it and drains it. */
function saboteur(g, s) {
  const o = g.o, t = g.terrain;
  const pick = () => {                                       // 3494
    const n = t.pyramidCountForRandom;
    const r = g.rng.next();
    o.link[s] = ((r * n) >> 8) * 2;
    o.t1[s] = setHi(o.t1[s], g.sabotageDelay);
    let spin = lo(o.t2[s]);
    if (spin === 0) spin = 0x10;
    o.t2[s] = setLo(o.t2[s], u8(-spin));
  };
  const spinAndFlash = () => {                               // 3500
    o.yaw[s] = setLo(o.yaw[s], lo(o.yaw[s]) + lo(o.t2[s]));
    hitFlash(g, s, 0x1c);
  };
  const descend = () => {                                    // 34f1
    heightTowards(g, s, 0, 0xa);
    keepClear(g, s, 0x3c);
    spinAndFlash();
  };
  let state = hi(o.t1[s]);
  if (state === 0xff) {                                      // 350e: draining
    g.saboteursActive = (g.saboteursActive ?? 0) + 1;        // [0x387C]
    const pyr = t.pyramids[o.link[s] >> 1];
    pyr.timer = (pyr.timer & 0xff00) | u8((pyr.timer & 0xff) - 1);
    if ((pyr.timer & 0xff) !== 0) { spinAndFlash(); return; }
    if ((g.rng.next() & 0xf) < g.sabotageChance) {          // 3585: carries it off
      o.type[s] = T.THIEF;
      t.destroyPyramid(o.link[s] >> 1, g);
      thief(g, s);
      return;
    }
    o.model[s] = 2;
    o.t1[s] = 0;
    t.destroyPyramid(o.link[s] >> 1, g);
    pick();
    state = hi(o.t1[s]);
  } else if (state === 0) {
    pick();
  }
  const pyr = t.pyramids[o.link[s] >> 1];
  const { angle, dist } = towards(g, s, pyr.x, pyr.z);
  g.targetAngle = angle;
  if (dist <= 0xc00) {
    if (pyr.timer & 0xff00) {                                // 353d: someone else is on it
      o.t1[s] = setHi(o.t1[s], 0);
      o.vx[s] = 0; o.vz[s] = 0;
      spinAndFlash();
      return;
    }
    o.t1[s] = setHi(o.t1[s], hi(o.t1[s]) + 1);
    if (dist <= 0x28) {                                      // 354e: land on it
      g.sound.request(0x1700);
      pyr.timer = (pyr.timer & 0xff) | 0x100;
      o.model[s] = 0x1c;
      o.vx[s] = 0; o.vz[s] = 0;
      o.x[s] = pyr.x; o.z[s] = pyr.z;
      o.t1[s] = setHi(o.t1[s], 0xff);
      descend();
      return;
    }
  }
  o.t1[s] = setHi(o.t1[s], hi(o.t1[s]) - 1);
  thrustAlong(g, s, angle, 0x78);
  o.model[s] = 2;
  descend();
}

/** 0x32E0: a saboteur that has taken a pyramid flees with it. */
function thief(g, s) {
  const o = g.o;
  o.roll[s] = setLo(o.roll[s], lo(o.roll[s]) + 0xe);
  const { angle } = towardsPlayer(g, s);
  const yaw = approach(lo(o.yaw[s]), angle, 0x20);
  o.yaw[s] = setLo(o.yaw[s], yaw);
  thrustAlong(g, s, yaw, g.fighterSpeed);
  heightTowards(g, s, s16(g.p.y), 0xa);
  keepClear(g, s, 0x3c);
  hitFlash(g, s, 0x12);
}

/** 0x3613: pods bounce to a rest and expire after a while. */
function pod(g, s) {
  const o = g.o;
  g.podLabels.push(s);
  o.yaw[s] = u16(o.yaw[s] + 6);
  const state = o.link[s];
  if (state === 0xffff) {                                    // 3661: just dropped
    const floor = g.terrain.heightAt(o.x[s], o.z[s]).height + 0x3c;
    if (floor < s16(o.y[s])) {
      o.t1[s] = floor; o.t2[s] = 0xffff; o.link[s] = 1;
      return;
    }
    o.y[s] = floor; o.link[s] = 0; o.t2[s] = 0;
    return;
  }
  if (state === 0) {                                         // 3691: resting, spins up then pops
    const v = u16(o.t2[s] + 1);
    o.t2[s] = v;
    o.yaw[s] = u16(o.yaw[s] + v);
    if (v === 0x1f) { o.type[s] = T.EXPLOSION; o.model[s] = 0x58f0; }
    return;
  }
  const y = s16(o.t2[s]) + s16(o.y[s]);                      // bouncing
  if (y <= s16(o.t1[s])) {
    o.y[s] = o.t1[s];
    const v = s16(-s16(o.t2[s]) - 6);
    o.t2[s] = u16(v);
    if (v > 0) return;
    o.link[s] = 0; o.t2[s] = 0;
    return;
  }
  o.y[s] = u16(y);
  o.t2[s] = u16(o.t2[s] - 4);
}

const BEHAVIOUR = {
  [T.EXPLOSION]: explosion,
  [T.SMALL_EXPLOSION]: smallExplosion,
  [T.DEFENDER]: defender,
  [T.SHRAPNEL]: shrapnel,
  [T.FALLING]: falling,
  [T.FIGHTER]: fighter,
  [T.GLIDER]: glider,
  [T.MINER]: miner,
  [T.SABOTEUR]: saboteur,
  [T.THIEF]: thief,
  [T.LUNGER]: lunger,
  0x00: idle, 0x01: expire, 0x02: idle,
};
for (let t = 0x37; t <= 0x3f; t++) BEHAVIOUR[t] = idle;
for (let t = 0x03; t <= 0x07; t++) BEHAVIOUR[t] = idle;
for (let t = 0x0a; t <= 0x0f; t++) BEHAVIOUR[t] = idle;
