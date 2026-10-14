import test from 'node:test';
import assert from 'node:assert/strict';
import { gameFiles } from './helpers.js';
import { loadGameData } from '../src/data/loader.js';
import { Arena } from '../src/game/arena.js';
import { SceneBuilder } from '../src/render/scene.js';

const files = gameFiles();
const skip = files ? false : 'original game files not available (set THUNDERSTRIKE_DIR)';

test('data decodes', { skip }, () => {
  const d = loadGameData(files);
  assert.equal(d.rounds.length, 50);
  assert.equal(d.models.size, 30);
  assert.equal(d.images.P_VGA.width, 320);
  assert.equal(d.anims.ANIM1V.frames.length, 8);
});

test('arena runs headless for a few thousand frames', { skip }, () => {
  const d = loadGameData(files);
  const sound = { request() {}, stopIfBelow() {} };
  const g = new Arena(d, sound);
  g.selectCraft(0);
  g.newGame();
  const sb = new SceneBuilder(d);
  let events = [];
  for (let f = 0; f < 3000; f++) {
    g.input.buttons = 1;
    g.input.x = (f % 200) < 100 ? 0x60 : 0xa0;
    g.input.y = 0x60;
    g.input.fireLatch = f % 3 === 0 ? 1 : 0;
    const ev = g.step();
    g.hudPhase();
    const prims = sb.build(g);
    assert.ok(prims.length > 0);
    if (ev) { events.push([f, ev]); if (ev === 'cleared') g.nextRound(); else break; }
  }
  console.log('events', events, 'enemies', g.enemies, 'bunkers', g.terrain.bunkersLeft, 'order', sb.order.length);
});
