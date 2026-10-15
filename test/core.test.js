import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng, Tables } from '../src/core/tables.js';
import { imulHi, s16, u16 } from '../src/core/int.js';
import { unpackRle } from '../src/data/igr.js';
import { gameFiles } from './helpers.js';
import { loadGameData } from '../src/data/loader.js';
import { pitchTable } from '../src/audio/music.js';

test('RNG follows s = s*5 + 0x65 (sub_8134)', () => {
  const r = new Rng();
  const seq = [r.next(), r.next(), r.next(), r.next()];
  assert.deepEqual(seq, [0x65, 0x5e, 0x3b, 0x8c]);
});

test('8086 helpers', () => {
  assert.equal(imulHi(0x4000, 0x0bb8), 0x2ee);
  assert.equal(imulHi(-0x4000, 0x0bb8), -0x2ee);
  assert.equal(s16(0x8000), -0x8000);
  assert.equal(u16(-1), 0xffff);
});

test('IGR RLE: literal runs and repeats', () => {
  const src = new Uint8Array([0x02, 1, 2, 3, 0xfd, 9, 0x00, 7]);
  const out = new Uint8Array(8);
  unpackRle(src, 0, src.length, out);
  assert.deepEqual([...out], [1, 2, 3, 9, 9, 9, 9, 7]);
});

const files = gameFiles();
const skip = files ? false : 'original game files not available';

test('trig tables behave like sine and arctangent', { skip }, () => {
  const t = loadGameData(files).tables;
  assert.equal(t.sinB(0), 0);
  assert.equal(t.sinB(0x40), 16383);
  assert.equal(t.cosB(0), 16383);
  assert.equal(t.atan2(0, 100), 0x00);       // straight ahead (+Z)
  assert.equal(t.atan2(100, 0), 0x40);       // +X
  assert.equal(t.atan2(0, -100), 0x80);
  assert.equal(t.atan2(-100, 0), 0xc0);
  assert.equal(t.atan2(100, 100), 0x20);
  for (const [v, a] of [[100, 0x20], [-50, 0x60], [77, 0xa0], [-127, 0xe0]]) {
    const want = Math.round(v * Math.sin((a * Math.PI) / 128));
    assert.ok(Math.abs(t.sinMulB(v, a) - want) <= 1, `sinMul(${v}, ${a})`);
  }
});

test('the music driver builds an equal-tempered note table (MZ.DAT:0x00FE)', { skip }, () => {
  const mz = loadGameData(files).mz;
  // same pitches whatever the measured loop rate
  for (const rate of [20000, 110000, 400000]) {
    const t = pitchTable(mz, rate);
    const hz = (i) => ((t[0x4c0 + i * 3] | (t[0x4c1 + i * 3] << 8) | (t[0x4c2 + i * 3] << 16)) / 2 ** 24) * rate;
    for (let i = 1; i < 84; i++) assert.ok(Math.abs(hz(i) / hz(i - 1) - 2 ** (1 / 12)) < 0.01, `step ${i}`);
    assert.ok(Math.abs(hz(80) - 3918) < 15, `A at ${hz(80)}`);
  }
});
