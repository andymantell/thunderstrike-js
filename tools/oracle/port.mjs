// Run the port's arena with generated key presses, recording its state and the keys.
// usage: node port.mjs frames slot out.json [--cheat=period] [--full] [--clear=period]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { gameFiles } = await import(join(root, 'test/helpers.js'));
const { loadGameData } = await import(join(root, 'src/data/loader.js'));
const { Flow } = await import(join(root, 'src/flow.js'));
const { Controls } = await import(join(root, 'src/input/controls.js'));
const { Canvas8 } = await import(join(root, 'src/render/hud.js'));
const { rasterise } = await import('./raster.mjs');

const [frames, slot, outFile] = [+process.argv[2], +process.argv[3], process.argv[4]];
const opt = Object.fromEntries(process.argv.slice(5).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const cheatPeriod = +(opt.cheat ?? 0), clearPeriod = +(opt.clear ?? 0);

process.chdir(root);
const files = gameFiles();
if (!files) { console.error('game files not found: put them in ./game or set THUNDERSTRIKE_DIR'); process.exit(2); }
const d = loadGameData(files);

// the INT 9 tables, set directly from the key list each frame
const kb = {
  state: new Uint8Array(128).fill(0x80), latch: new Uint8Array(128), last: 0,
  held(sc) { return (this.state[sc] & 0x80) === 0; },
  take(sc) { const v = this.latch[sc]; this.latch[sc] = 0; return v; },
  anyLatched() { return this.latch.some((v) => v); },
  clearLatches() { this.latch.fill(0); },
};
const nop = () => {};
const app = {
  data: d, keyboard: kb, controls: new Controls(kb, d.exe.ds),
  speaker: { play: nop, request: nop, flush: nop, stopIfBelow: nop, tick: nop, busy: () => false },
  music: { play: nop, stop: nop, playing: false },
  screen: new Canvas8(320, 200), view: new Canvas8(256, 128),
  renderer: { setPrimitives: nop, quarters: 0xf, mode: 0 },
  showBuffer: nop, showOverlay3D: nop, show3D: nop, showScreen: nop, setColours: nop, resetPalette: nop, quit: nop, frameTicks: 0,
};
const flow = new Flow(app);
const g = flow.arena;

/** run a front-end coroutine to its end, as if no key were pressed */
function drain(gen) {
  for (let guard = 0; guard < 1e6; guard++) {
    const r = gen.next();
    if (r.done) return;
    if (typeof r.value === 'function') for (let n = 0; n < 1e5 && !r.value(); n++);
  }
  throw new Error('front-end routine did not finish');
}

// key script: thrust, turn, climb and dive in cycles, fire every fourth frame
function scripted(f) {
  const h = [];
  if (f % 40 < 30) h.push(0x19);
  const ph = Math.floor(f / 50) % 3;
  if (ph === 0) h.push(0x2c); else if (ph === 1) h.push(0x2d);
  if (f % 4 === 0) h.push(0x39);
  if (f % 100 < 20) h.push(0x26); else if (f % 100 >= 50 && f % 100 < 60) h.push(0x33);
  return h;
}
const SKIP = [0x20, 0x1e, 0x2f, 0x12, 0x14, 0x18, 0x31, 0x15];                          // DAVETONY
const FULL = [0x19, 0x17, 0x13, 0x1e, 0x2e, 0x15, 0x17, 0x1f, 0x14, 0x23, 0x12, 0x21, 0x14];  // PIRACYISTHEFT
function keysFor(f) {
  if (cheatPeriod) {
    const p = f % cheatPeriod, at = cheatPeriod - 100;
    const seq = opt.full && f < cheatPeriod ? SKIP.concat(FULL) : SKIP;
    if (p >= at && p < at + seq.length * 2) return (p & 1) ? [] : [seq[(p - at) >> 1]];
  }
  return scripted(f);
}

// mouse script: sweeping steering and height, left button (thrust) mostly held, right (fire) tapped
function mouseFor(f) {
  const x = Math.round(0x80 + 0x70 * Math.sin(f / 37)) & 0xff, y = Math.round(0x80 + 0x50 * Math.sin(f / 23)) & 0xff;
  return [x, y, (f % 40 < 30 ? 1 : 0) | (f % 4 === 0 ? 2 : 0)];
}
const mouse = !!opt.mouse;
if (mouse) app.controls.mode = 'mouse';
flow.craftSlot = slot;
g.selectCraft(slot);
app.controls.reset();
g.newGame();
const FIELDS = ['x', 'y', 'z', 'model', 'vxv', 'vyv', 'vzv', 'pitch', 'yaw', 'roll', 'vx', 'vy', 'vz', 'type', 'cell', 't1', 't2', 'link', 'damage', 'hp', 'flags'];
let held = new Set();
const out = [], keyLog = [];
for (let f = 0; f < frames; f++) {
  const k = new Set(mouse ? (cheatPeriod ? keysFor(f).filter((sc) => sc !== 0x19 && sc !== 0x39 && sc !== 0x2c && sc !== 0x2d && sc !== 0x26 && sc !== 0x33) : []) : keysFor(f));
  if (mouse) {
    const [x, y, b] = mouseFor(f), m = app.controls.mouse;
    // int 33h function 5 counts presses: right (button 1) is fire, left (button 0) thrust
    if (b & 2 && !(m.buttons & 2)) m.pressed[0]++;
    if (b & 1 && !(m.buttons & 1)) m.pressed[1]++;
    m.x = x; m.y = y; m.buttons = b;
    keyLog.push({ keys: [...k], mouse: [x, y, b] });
  } else keyLog.push([...k]);
  for (let sc = 1; sc < 128; sc++) {
    if (k.has(sc) && !held.has(sc)) { kb.latch[sc] = 1; kb.last = sc; }
    kb.state[sc] = k.has(sc) ? 0 : 0x80;
  }
  held = k;
  if (clearPeriod && f % clearPeriod === clearPeriod - 1) { g.terrain.bunkersLeft = 0; g.enemies = 0; }
  // the arena loop as Flow.play runs it, minus drawing
  if (flow.checkCheat()) g.nextRound();
  app.controls.read(g.input);
  g.input.refuel = kb.held(0x43);
  const ev = g.step();
  if (ev === 'cleared') {
    drain(flow.roundComplete());
    g.rechargeShield();
    kb.clearLatches();
    g.nextRound();
    app.controls.read(g.input);
    g.finishFrame();
  }
  g.hudPhase();
  const prims = flow.scene.build(g);
  flow.hud.draw(g, flow.scene, app.view, app.screen, nop);
  flow.hud.counters(g, app.screen);
  const s = {};
  for (const n of FIELDS) s[n] = Array.from(g.o[n].slice(0, 24));
  Object.assign(s, {
    rng: d.rng.seed, shield: g.shield, fuel: g.p.fuel, round: g.round & 0xffff, roundOver: g.roundOver, dying: g.dying,
    craft: [g.craft.accel, g.craft.speed, g.craft.turn], camera: [g.camYaw, g.camAngle, g.camHeight],
    map: Buffer.from(g.terrain.map.slice(0, 0x2000)).toString('hex'),
  });
  if (opt.pictures && f % +opt.pictures === 0) {
    s.view = Buffer.from(app.view.d).toString('hex');
    const frame = rasterise(prims, g.groundColour ?? 0);
    for (let i = 0; i < frame.length; i++) if (app.view.d[i]) frame[i] = app.view.d[i];
    s.frame = Buffer.from(frame).toString('hex');
    s.screen = Buffer.from(app.screen.d).toString('hex');
  }
  out.push(s);
  if (ev && ev !== 'cleared') break;   // game over: the original leaves the loop here
}
fs.writeFileSync(outFile, JSON.stringify(out));
fs.writeFileSync(outFile.replace(/\.json$/, '.keys.json'), JSON.stringify(keyLog));
