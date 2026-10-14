/**
 * Top-level controller: owns the renderer, timing, input and sound, and
 * runs the current screen. The game's own flow (title, menus, rounds) lives
 * in flow.js; this file only provides the 50 Hz "PC" the game runs on.
 */
import { Renderer } from './render/renderer.js';
import { Canvas8 } from './render/hud.js';
import { Keyboard } from './input/keyboard.js';
import { Controls } from './input/controls.js';
import { Speaker } from './audio/speaker.js';
import { Flow } from './flow.js';

const TICK_MS = 1000 / 50;   // PIT programmed with divisor 0x5D37

/** Standard VGA BIOS colours 0..15 (the game never redefines these). */
const VGA_DEFAULT_16 = [
  0, 0, 0, 0, 0, 42, 0, 42, 0, 0, 42, 42, 42, 0, 0, 42, 0, 42, 42, 21, 0, 42, 42, 42,
  21, 21, 21, 21, 21, 63, 21, 63, 21, 21, 63, 63, 63, 21, 21, 63, 21, 63, 63, 63, 21, 63, 63, 63,
];

export class App {
  constructor(canvas, data) {
    this.canvas = canvas;
    this.data = data;
    this.renderer = new Renderer(canvas);
    this.screen = new Canvas8(320, 200, this.renderer.screen);
    this.view = new Canvas8(256, 128, this.renderer.overlay);
    this.keyboard = new Keyboard(window);
    this.controls = new Controls(this.keyboard, data.exe.ds);
    this.speaker = new Speaker(data.mz);
    this.dac = new Uint8Array(768);
    this.dac.set(VGA_DEFAULT_16);
    this.ticks = 0;            // timer interrupts since start
    this.frameTicks = 0;       // cs:81E8
    this.waitTicks = 0;        // cs:81E6
    this.flow = new Flow(this);
    window.addEventListener('resize', () => this.fit());
    const wake = () => this.speaker.resume();
    window.addEventListener('keydown', wake);
    window.addEventListener('pointerdown', wake);
    this.setupMouse();
    this.fit();
  }

  setupMouse() {
    const m = this.controls.mouse;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.controls.mode === 'mouse' && document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock?.();
      if (e.button === 0) { m.buttons |= 1; m.pressed[1] = 1; }
      if (e.button === 2) { m.buttons |= 2; m.pressed[0] = 1; }
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) m.buttons &= ~1;
      if (e.button === 2) m.buttons &= ~2;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      m.x = Math.max(0, Math.min(255, m.x + e.movementX / 2));
      m.y = Math.max(0, Math.min(255, m.y + e.movementY / 2));
    });
  }

  /** 4:3 display of the 320x200 mode-13h screen. */
  fit() {
    const w = window.innerWidth, h = window.innerHeight;
    const s = Math.max(1, Math.min(w / 320, h / 240));
    const cw = Math.floor(320 * s), ch = Math.floor(240 * s);
    this.canvas.style.width = cw + 'px';
    this.canvas.style.height = ch + 'px';
    this.renderer.resize(cw, ch);
  }

  setColours(first, rgb) { this.dac.set(rgb.subarray(0, Math.min(rgb.length, 768 - first * 3)), first * 3); this.paletteDirty = true; }
  blackPalette() { this.dac.fill(0); this.paletteDirty = true; }

  run() {
    this.start = performance.now();
    const loop = (now) => {
      const due = Math.floor((now - this.start) / TICK_MS);
      let n = Math.min(due - this.ticks, 25);
      if (due - this.ticks > 25) this.ticks = due - 25;
      while (n-- > 0) this.tick();
      if (this.paletteDirty) { this.renderer.setPalette(this.dac); this.paletteDirty = false; }
      this.renderer.present();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** One 50 Hz timer interrupt (cs:8254): sound driver tick and frame pacing. */
  tick() {
    this.ticks++;
    this.frameTicks++;
    this.waitTicks++;
    this.speaker.tick();
    this.flow.tick();
  }
}
