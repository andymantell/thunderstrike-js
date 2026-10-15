// The port's attract demo, headless: the work buffer (3D view, half size) and the quarters after each frame.
// usage: node attract.mjs frames out.json
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
process.chdir(root);
const [frames, outFile] = [+process.argv[2], process.argv[3]];
const d = loadGameData(gameFiles());
const kb = { state: new Uint8Array(128).fill(0x80), latch: new Uint8Array(128), last: 0, held: () => false, take: () => 0, anyLatched: () => false, clearLatches() {} };
const nop = () => {};
const out = [];
let prims = [];
const app = {
  data: d, keyboard: kb, controls: new Controls(kb, d.exe.ds), frameTicks: 5,
  speaker: { play: nop, request: nop, flush: nop, stopIfBelow: nop, tick: nop }, music: { play: nop, stop: nop, playing: false },
  screen: new Canvas8(320, 200), view: new Canvas8(256, 128),
  renderer: { quarters: 0xf, setPrimitives: (p) => { prims = p; } },
  showBuffer: nop, showOverlay3D: nop, show3D: nop, showScreen: nop, setColours: nop, resetPalette: nop,
};
const flow = new Flow(app);
const g = flow.arena;
const co = flow.attractDemo();
let frame = -1;
for (let guard = 0; guard < 1e6 && out.length < frames; guard++) {
  const r = co.next();
  if (r.done) break;
  if (typeof r.value === 'function') {
    // each wait for the frame timer starts a new frame: record the one just drawn
    if (frame >= 0) out.push({ view: Buffer.from(rasterise(prims, g.groundColour ?? 0)).toString('hex'), quarters: app.renderer.quarters, x: g.o.x[0], z: g.o.z[0], yaw: g.p.yaw, in: g.input.x, rng: d.rng.seed });
    frame++;
    app.frameTicks = 5;
  }
}
fs.writeFileSync(outFile, JSON.stringify(out));
