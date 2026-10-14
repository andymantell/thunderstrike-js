import test from 'node:test';
import assert from 'node:assert/strict';
import { gameFiles } from './helpers.js';
import { loadGameData } from '../src/data/loader.js';
import { Arena } from '../src/game/arena.js';
import { SceneBuilder } from '../src/render/scene.js';
import { s16, u8 } from '../src/core/int.js';

const files = gameFiles();
const skip = files ? false : 'original game files not available (set THUNDERSTRIKE_DIR)';

/** Fly at the nearest live bunker and fire: enough to clear early rounds. */
function pilot(g) {
  const t = g.terrain;
  let best = null, bd = Infinity;
  for (const b of t.bunkers) {
    if (s16(b.health) <= 0) continue;
    // aim at the pad south of the centre; sub_156F looks up column+1, row-15
    const bx = ((((b.cell & 0x3f) - 1) << 10) + 0x200) & 0xffff, bz = ((((b.cell >> 6) + 14) << 10) + 0x200) & 0xffff;
    const dx = s16(bx - g.p.x), dz = s16(bz - g.p.z);
    const d = Math.abs(dx) + Math.abs(dz);
    if (d < bd) { bd = d; best = [dx, dz]; }
  }
  let want = g.p.yaw;
  if (best) want = g.tables.atan2(best[0], best[1]);
  else {
    const e = [...Array(24).keys()].find((s) => g.o.type[s] >= 0x31 && g.o.type[s] <= 0x36);
    if (e !== undefined) want = g.tables.atan2(s16(g.o.x[e] - g.p.x), s16(g.o.z[e] - g.p.z));
  }
  const d = s8(want - g.p.yaw);
  g.input.x = d > 4 ? 0xff : d < -4 ? 0x00 : 0x80;   // the default curve (DS:0x3D16) has a wide dead zone
  g.input.y = 0x90;           // low enough for shots to reach the pads, high enough to avoid track lock
  g.input.buttons = bd > 0x1800 ? 1 : 0;
  g.input.fireLatch = (g.frame & 1);
}
const s8 = (v) => (v << 24) >> 24;

test('an autopilot can destroy bunkers and finish rounds', { skip }, () => {
  const d = loadGameData(files);
  const g = new Arena(d, { request() {}, stopIfBelow() {}, flush() {} });
  g.selectCraft(1);
  g.newGame();
  const sb = new SceneBuilder(d);
  const log = [];
  let bunkerHits = 0;
  for (let f = 0; f < 20000 && g.round < 3; f++) {
    pilot(g);
    const before = g.terrain.bunkersLeft;
    const ev = g.step();
    g.hudPhase();
    sb.build(g);
    if (g.terrain.bunkersLeft < before) bunkerHits++;
    if (ev) {
      log.push([f, g.round, ev, g.stats.round.hits, g.stats.round.shots]);
      if (ev !== 'cleared') { g.newGame(); continue; }
      g.nextRound();
    }
  }
  console.log(log, 'bunkers destroyed', bunkerHits);
  assert.ok(bunkerHits > 0);
});
