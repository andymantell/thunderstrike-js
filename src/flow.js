/**
 * Game flow: title, attract demo, menus, craft selection, round intro and
 * results screens, and the arena itself.
 *
 * The original front end is sequential C code that busy-waits on the timer
 * tick counter. Each routine here is a generator driven by the 50 Hz tick:
 * `yield n` waits n ticks, `yield fn` waits until fn() is true, and
 * `yield* other()` calls a sub-routine. Comments name the routine each
 * generator reimplements. All pictures and texts come from the player's
 * files; DS offsets below point at the original strings.
 */
import { Arena, approach } from './game/arena.js';
import { T } from './game/objects.js';
import { SceneBuilder } from './render/scene.js';
import { Hud, Fonts } from './render/hud.js';
import { Display } from './ui/display.js';
import { runAll as aiRun } from './game/ai.js';
import { s16, u8, u16 } from './core/int.js';

const SC_ESC = 0x01, SC_F4 = 0x3e, SC_F10 = 0x44, SC_SPACE = 0x39, SC_ENTER = 0x1c, SC_Q = 0x10;

export class Flow {
  constructor(app) {
    this.app = app;
    this.data = app.data;
    this.ds = app.data.exe.ds;
    this.scene = new SceneBuilder(app.data);
    this.hud = new Hud(app.data);
    this.display = new Display(app);
    this.arena = new Arena(app.data, app.speaker);
    this.craftSlot = 0;            // [0x4286] = slot * 2
    this.firstIntro = true;        // [0xAE0C]
    this.pauseToggle = 0x80;       // toggle bit for F10 (DS:0x9ED0)
    this.co = this.main();
    this.waiting = null;
  }

  /** Run the active coroutine for one timer tick. */
  tick() {
    if (this.waiting && !this.waiting()) return;
    this.waiting = null;
    for (let guard = 0; guard < 64; guard++) {
      const r = this.co.next();
      if (r.done) { this.co = this.main(); return; }
      const v = r.value;
      if (typeof v === 'number') {
        let n = v;
        this.waiting = () => --n <= 0;
        return;
      }
      if (typeof v === 'function') {
        if (v()) continue;
        this.waiting = v;
        return;
      }
      return;
    }
  }

  // ------------------------------------------------------------ helpers

  get kb() { return this.app.keyboard; }

  /** sub_77F0: code of the first held key (via DS:0xA1C6), 0x9D for fire, else 0. */
  inkey() {
    for (let sc = 0; sc < 128; sc++) {
      if (!this.kb.held(sc)) continue;
      const c = this.ds.u8(0xa1c6 + sc);
      if (c === 0x9d || c === 0xfd || c === 0xfc) continue;
      return c;
    }
    const input = {};
    this.app.controls.read(input);
    return input.buttons & 2 ? 0x9d : 0;
  }

  /** sub_9DBD + timer: wait `n` ticks. */
  *wait(n) { yield n; }

  /** sub_B892: wait `delay` ticks, show the "more" marker, then wait for a key or `timeout` ticks. */
  *pause(delay, timeout) {
    yield delay;
    this.display.print(0xe, 0x1c, 0xf, this.ds.cstr(0xbefd));
    this.display.blit();
    let t = 0;
    yield () => this.inkey() !== 0 || ++t >= timeout;
  }

  /** int 80h AH=1/AH=0: play a tune until it ends or a key is pressed; returns true if a key ended it. */
  *playTune(tune) {
    const m = this.app.music;
    m.play(tune);
    let key = false;
    yield () => {
      if (this.inkey() !== 0 || this.kb.anyLatched()) { key = true; return true; }
      return !m.playing;
    };
    m.stop();
    this.kb.clearLatches();
    return key;
  }

  /** sub_8280: start a sound effect immediately (int 80h AH=81h). */
  sfx(id) { this.app.speaker.play(id); }

  // --------------------------------------------------------- top level

  /** CS:2251 title loop, CS:229E game start, CS:22C1 main loop. */
  *main() {
    for (;;) {
      const start = yield* this.title();
      if (!start) continue;
      yield* this.startGame();
    }
  }

  /** CS:2251: title picture, tune 0, then the attract demo. */
  *title() {
    const app = this.app, tp = this.data.images.TPV;
    this.panelLoaded = false;
    app.resetPalette();
    app.showScreen();
    app.screen.clear(0);
    app.screen.blit(tp);
    app.setColours(tp.firstColour, tp.palette);
    yield 0x6e;
    if (yield* this.playTune(0)) return true;
    this.loadPanel();
    return yield* this.attractDemo();
  }

  /** sub_5DC6: the cockpit picture and its palette, loaded once per title visit. */
  loadPanel() {
    const app = this.app, panel = this.data.images.P_VGA;
    if (!this.panelLoaded) {
      app.screen.clear(0);
      app.screen.blit(panel);
      app.setColours(panel.firstColour, panel.palette);
      this.panelLoaded = true;
      // 630b: the gauges start empty and fill up frame by frame
      this.arena.gauges.shield = 0xffff; this.arena.gauges.threat = 0xffff;
    }
    app.setColours(0x10, this.data.palette.dac.subarray(0x30, 0x30 + 0x70 * 3));
  }

  /** CS:229E onwards */
  *startGame() {
    const g = this.arena;
    this.app.music.stop();
    this.loadPanel();
    yield* this.intro();                 // 9e64
    yield* this.mainMenu();              // a198
    this.display.clear();
    g.selectCraft(this.craftSlot);       // 2bab
    this.app.controls.reset();           // [0x9FFC]
    g.newGame();                         // 297f
    yield* this.roundIntro();            // abef via 29a0
    yield* this.play();
  }

  // ----------------------------------------------------------- arena

  /** CS:22C1 main loop. */
  *play() {
    const app = this.app, g = this.arena;
    this.applyArenaLook();
    app.frameTicks = 0;
    for (;;) {
      yield () => app.frameTicks >= 5;
      app.frameTicks = 0;
      if (this.kb.take(SC_F4) && !g.roundOver) yield* this.statsOverlay();   // 11ee
      if (this.checkCheat()) { g.nextRound(); yield* this.roundIntro(); this.applyArenaLook(); app.frameTicks = 0; continue; } // 2927 -> 29a0
      app.controls.read(g.input);
      g.input.refuel = this.kb.held(0x43);
      const ev = g.step();
      if (ev === 'cleared') {
        yield* this.roundComplete();     // 2b24 -> a9fb
        g.rechargeShield();              // 273
        this.kb.clearLatches();
        g.nextRound();
        yield* this.roundIntro();
        this.applyArenaLook();
        app.frameTicks = 0;
        continue;
      }
      if (ev === 'shutdown') { yield* this.gameOver(0x102a, this.data.images.SHTDWNV); return; }
      if (ev === 'destroyed') { yield* this.gameOver(0x1090, this.data.images.EXPLODEV); return; }
      // F10 pause, Q single-steps while paused (23ab)
      if (this.kb.take(SC_F10)) this.pauseToggle ^= 0x80;
      if (!(this.pauseToggle & 0x80)) yield () => this.kb.held(SC_Q) || (this.kb.take(SC_F10) && (this.pauseToggle ^= 0x80, true));
      this.renderFrame();
      if (this.kb.held(SC_ESC)) {
        const quit = yield* this.abortMenu();          // a2b0
        if (quit) return;
        this.applyArenaLook();
      }
    }
  }

  /** Sky, base palette and panel counters for the current arena (sub_61AD and friends). */
  applyArenaLook() {
    const app = this.app, g = this.arena;
    this.loadPanel();
    app.setColours(0x80, this.data.skies[g.arena]);
    this.hud.counters(g, app.screen);
    app.show3D();
  }

  renderFrame() {
    const app = this.app, g = this.arena;
    app.speaker.flush();                                   // 82a6
    g.hudPhase();
    const prims = this.scene.build(g);
    app.renderer.setPrimitives(prims, g.groundColour ?? 0, 'sky');
    this.hud.draw(g, this.scene, app.view, app.screen, () => app.speaker.request(0x0764));
    this.hud.counters(g, app.screen);
  }

  /**
   * sub_2927: the developers' cheat, a scancode sequence stored at
   * DS:0x4223. Reaching an entry of 0x19 skips to the next round; reaching
   * the terminating zero maxes out the craft and power-ups. Returns true
   * when the round was skipped.
   */
  checkCheat() {
    const ds = this.ds, sc = this.kb.last;
    let si = this.cheatIndex ?? 0;
    if (sc === ds.u8(0x4223 + si)) {
      si++;
      this.cheatIndex = si;
      const next = ds.u8(0x4223 + si);
      if (next === 0) {
        const g = this.arena;
        g.craft.turn = 0x95; g.craft.speed = 0xc7; g.craft.accel = 0x63;
        g.twinShots = 0x3e7; g.powerShots = 0x3e7; g.turbos = 0x3e7;
        g.deriveCraft();
      } else if (next === 0x19) return true;
      return false;
    }
    if (si && sc === ds.u8(0x4223 + si - 1)) return false;
    this.cheatIndex = 0;
    return false;
  }

  /** sub_11EE: F4 shows the stats over the arena overview until a key is pressed. */
  *statsOverlay() {
    const d = this.display, g = this.arena, ds = this.ds;
    computeRates(g, ds);
    this.kb.clearLatches();
    this.statsBlink ??= ds.u8(0x19ef);   // [0x19EF] keeps its phase between visits
    for (;;) {
      this.overview();
      d.print(4, 1, 1, ds.cstr(0x10a9));
      d.print(4, 1, 6, ds.cstr(0x10da));
      const c = this.statsBlink; this.statsBlink ^= 8;
      const col = (((g.p.x >> 8) >> 4) & 0xf) + 0x10, row = (((-(g.p.z >> 8)) & 0xff) >> 4) & 0xf;
      d.print(c, col, row, '\x7f');
      d.print(4, 1, 0xb, ds.cstr(0x110b));
      d.blit();
      yield 5;
      if (this.kb.anyLatched()) break;
    }
    this.kb.clearLatches();
    this.app.show3D();
  }

  /** sub_642D: top-down map of the arena's surface layer. */
  overview() {
    const d = this.display, map = this.arena.terrain.map;
    let k = (this.overviewK ?? 0) + 1; this.overviewK = k;
    const anim = this.ds.u8(0x641d + (k & 0xf));
    d.clear();
    let si = 0x1c00;
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < 64; c++) {
        let al = map[si++] & 0x7f;
        if (al >= 0x70) al = anim; else if (al < 0x10) al = 0;
        const x = 0x80 + c * 2, y = r * 2;
        d.work.plot(x, y, al); d.work.plot(x + 1, y, al);
        d.work.plot(x, y + 1, al); d.work.plot(x + 1, y + 1, al);
      }
      si = ((si - 0x80) & 0xfff) + 0x1000;
    }
  }

  /** sub_A2B0: Esc in the arena. Returns true when the game is abandoned. */
  *abortMenu() {
    const items = [[0xbbbd, 0], [0xbbcc, 0x40], [0xbbdb, 0x80]];
    this.menuReady = false;
    for (;;) {
      this.menuPicture(items);
      const si = yield* this.menuSelect();
      if (si === 0) {
        if (yield* this.confirm(0xbbea)) return true;
        continue;
      }
      if (si === 1) { this.sfx(0xf); yield* this.optionsMenu(); continue; }
      if (si === 2 || si === 4) return false;
    }
  }

  // ------------------------------------------------------- menus

  menuPicture(items) {
    const d = this.display, im = this.data.images;
    d.picture(im.MANV, 0, 0, 0);
    const names = { 0xbb68: 'MENUDOSV', 0xbb77: 'MENUOPTV', 0xbb86: 'MENUPLAV', 0xbb95: 'MENUCRAV', 0xbbbd: 'MENUABOV',
      0xbbcc: 'MENUOPTV', 0xbbdb: 'MENUPLAV', 0xbc4c: 'MENUMENV', 0xbc5b: 'MENUKEYV', 0xbc6a: 'MENUMOUV', 0xbc79: 'MENUMISV' };
    for (const [file, x] of items) d.picture(im[names[file]], x, 0x60, 0);
    d.blit();
  }

  /** sub_A198: main menu. Returns when the player chooses to play. */
  *mainMenu() {
    const items = [[0xbb68, 0], [0xbb77, 0x40], [0xbb86, 0x80], [0xbb95, 0xc0]];
    let idle = 0;
    this.menuPicture(items);
    this.menuReady = false;
    for (;;) {
      const si = yield* this.menuSelect(() => ++idle > 0x258);
      if (si === 0) {
        if (yield* this.confirm(0xbba4)) { this.app.quit(); }
        this.menuPicture(items); idle = 0;
        continue;
      }
      if (si === 1) { this.sfx(0xf); yield* this.optionsMenu(); this.menuPicture(items); idle = 0; continue; }
      if (si === 3) { this.sfx(0xf); yield* this.craftSelect(); this.menuPicture(items); idle = 0; continue; }
      if (si === 2 || si === 4) return;
      if (si < 0) { yield* this.attractDemo(); this.loadPanel(); this.menuPicture(items); idle = 0; }
    }
  }

  /** sub_9E12 + blit + sub_9E57: show the work buffer with the pointer on it; returns the pointer. */
  pointer() {
    const p = this.app.controls.pointer();
    this.display.blitWithPointer(p.x, p.y);
    return p;
  }

  get mouseMode() { return this.app.controls.mode === 'mouse'; }

  /**
   * sub_A4DB: menu choice from the keyboard (Esc=0, F1..F3=1..3, fire=4 with
   * the keyboard) or a mouse click on one of the 64x24 buttons at y=0x60.
   * A choice only counts if nothing was pressed at the previous poll
   * ([0xC67C], shared with the mouse options screen).
   */
  *menuSelect(onIdle) {
    let result = -1;
    this.kb.clearLatches();
    yield () => {
      const p = this.mouseMode ? this.pointer() : null;
      const c = u8(-this.inkey());
      let r = -1;
      if (c === 2) r = 0;
      else if (c >= 0xb && c <= 0xd) r = c - 0xa;
      else if (!p && c === 0x63) r = 4;
      if (p) {
        if (p.buttons) r = r < 0 ? -2 : r;
        const sx = p.x & 0x3f;
        if (r < 0 && p.buttons && p.y >= 0x61 && p.y <= 0x76 && sx >= 2 && sx <= 0x3d) r = p.x >> 6;
      }
      result = this.menuReady ? r : -1;
      this.menuReady = r === -1;
      return result >= 0 || (onIdle ? onIdle() : false);
    };
    return result;
  }

  /** sub_A360: "ARE YOU SURE ?(y/n)" */
  *confirm(textOff) {
    const d = this.display;
    d.picture(this.data.images.MANV, 0, 0, 0);
    d.printShadow(4, 1, 2, this.ds.cstr(textOff));
    d.printShadow(4, 1, 4, this.ds.cstr(0xbc05));
    d.blit();
    let r = null;
    yield () => {
      const c = this.inkey();
      if (c === 0x59) r = true;
      if (c === 0x4e) r = false;
      return r !== null;
    };
    yield () => this.inkey() === 0;
    return r;
  }

  /** sub_A3F0: options (back, controls, information). */
  *optionsMenu() {
    const mouse = this.app.controls.mode === 'mouse';
    const items = [[0xbc4c, 0], [mouse ? 0xbc6a : 0xbc5b, 0x40], [0xbc79, 0x80]];
    this.menuReady = false;
    for (;;) {
      this.menuPicture(items);
      const si = yield* this.menuSelect();
      if (si === 0 || si === 4) { this.sfx(0xf); return; }
      if (si === 1) { this.sfx(0xf); if (mouse) yield* this.mouseSettings(); else yield* this.redefineKeys(); }
      if (si === 2) { this.sfx(0xf); yield* this.information(); }
    }
  }

  /** sub_919D: press a key for each control in turn. */
  *redefineKeys() {
    const d = this.display, ds = this.ds, c = this.app.controls;
    d.clear();
    this.kb.clearLatches();
    const order = ['left', 'right', 'thrust', 'fire', 'up', 'down'];
    const taken = [];
    for (let i = 0; i < 6; i++) {
      const row = 0xc - (6 - i);
      d.print(4, 1, row, ds.cstr(0xa75c));
      d.print(4, 0xf, row, ds.cstr(0xa76b + i * 8));
      d.blit();
      let sc = 0;
      yield () => {
        for (let k = 1; k < 128; k++) {
          if (!this.kb.latch[k]) continue;
          this.kb.latch[k] = 0;
          if (ds.u8(0xa1c6 + k) & 0x80) continue;   // sub_7F36: no name, not accepted
          if (taken.includes(k)) continue;
          sc = k; return true;
        }
        return false;
      };
      taken.push(sc);
      c.keys[order[i]] = sc;
      d.print(4, 0xf + ds.cstr(0xa76b + i * 8).length, row, keyName(ds, sc));   // continues after the label
      d.blit();
    }
    yield 25;
  }

  /**
   * sub_A056 (mouse mode): two speed sliders and two check boxes, worked
   * with the pointer. Clicking below the boxes (y > 0x60) leaves.
   */
  *mouseSettings() {
    const d = this.display, w = d.work, c = this.app.controls;
    const sliders = [{ x: 0x8c, y: 0x20 }, { x: 0x8c, y: 0x30 }];
    const boxes = [
      { x: 0x8c, y: 0x40, get: () => c.invertY, toggle: () => { c.invertY = !c.invertY; } },
      { x: 0x8c, y: 0x50, get: () => c.swapButtons, toggle: () => { c.swapButtons = !c.swapButtons; } },
    ];
    const MAX = 0x32;
    // sub_B124: rectangle outline
    const rect = (x0, y0, x1, y1, col) => { w.line(x0, y0, x1, y0, col); w.line(x1, y0, x1, y1, col); w.line(x1, y1, x0, y1, col); w.line(x0, y1, x0, y0, col); };
    // sub_B05A: slider box, end ticks and the marker
    const slider = (i, on) => {
      const { x, y } = sliders[i];
      rect(x, y, x + 0x3f, y + 0xc, 2 & on);
      w.line(x + 0xb, y, x + 0xb, y + 0xc, 2 & on);
      w.line(x + 0x34, y, x + 0x34, y + 0xc, 2 & on);
      const mx = x + Math.trunc(((c.mouseSpeed[i] + 1) << 5) / MAX) + 0xc;
      rect(mx, y + 1, mx + 7, y + 0xb, 0xa & on);
    };
    // sub_A898: check box, crossed when set
    const box = (i, on) => {
      const { x, y } = boxes[i];
      rect(x, y, x + 9, y + 9, 2 & on);
      if (boxes[i].get()) { w.line(x, y, x + 9, y + 9, 2 & on); w.line(x, y + 9, x + 9, y, 2 & on); }
    };
    d.clear();
    d.print(4, 0, 1, this.ds.cstr(this.ds.u16(0xae24)));
    for (let i = 0; i < 2; i++) slider(i, 0xff);
    for (let i = 0; i < 2; i++) box(i, 0xff);
    let done = false;
    this.menuReady = false;
    yield () => {
      const p = this.pointer();
      if (p.buttons) {
        // sub_A70A: sliders follow a held button, boxes toggle on a new click
        sliders.forEach((s, i) => {
          if (p.x < s.x || p.y < s.y || p.x >= s.x + 0x40 || p.y >= s.y + 0xc) return;
          slider(i, 0);
          const dx = p.x - s.x;
          let v = c.mouseSpeed[i];
          if (dx <= 0xc) v--;
          else if (dx >= 0x34) v++;
          else v = Math.trunc((MAX * (dx - 0x10)) / 0x20) - 1;
          c.mouseSpeed[i] = Math.max(0, Math.min(MAX, v));
          slider(i, 0xff);
        });
        if (this.menuReady) boxes.forEach((b, i) => {
          if (p.x < b.x || p.y < b.y || p.x >= b.x + 0xa || p.y >= b.y + 0xa) return;
          box(i, 0); b.toggle(); box(i, 0xff);
        });
        if (this.menuReady && p.y > 0x60) done = true;
      }
      this.menuReady = !p.buttons;
      return done;
    };
  }

  /** sub_A14B: information page. */
  *information() {
    const d = this.display;
    d.picture(this.data.images.MANV, 0, 0, 0);
    d.printShadow(0xd, 0, 1, this.ds.cstr(this.ds.u16(0xae26)));
    d.printShadow(4, 0, 0xe, this.ds.cstr(0xbb3c));
    d.blit();
    yield* this.playTune(0);
  }

  // -------------------------------------------------- talking heads

  /** sub_9F7D: studio picture and the presenter's first animation frame. */
  studio() {
    const d = this.display;
    d.picture(this.data.images.F1V, 0, 0, 0xec);
  }

  /**
   * sub_9FB9: print a caption and lip-sync it with the digit string (one
   * frame every 7 ticks). A key press stops it early; returns true then.
   */
  *talk(anim, col, row, textOff, mouthOff, restore) {
    const d = this.display, ds = this.ds;
    d.printShadow(0xe, col, row, ds.cstr(textOff));
    let key = this.inkey() !== 0;
    for (let i = 0; !key && ds.u8(mouthOff + i); i++) {
      d.animFrame(anim, ds.u8(mouthOff + i) - 0x30);
      d.blit();
      let t = 0;
      yield () => { key = this.inkey() !== 0; return key || ++t >= 7; };
      if (key) { d.animFrame(anim, 0); d.blit(); }
    }
    if (restore) { this.studio(); d.animFrame(anim, 0); }
    return key;
  }

  /** sub_9E64: the presenter's introduction, shown once per session. */
  *intro() {
    if (!this.firstIntro) return;
    const d = this.display, anim = this.data.anims.ANIM1V;
    d.clear(); d.blit();
    this.studio(); d.animFrame(anim, 0);
    const lines = [[0xb8c1, 0xb902], [0xb92a, 0xb961], [0xb97b, 0xb9a8], [0xb9c2, 0xba01], [0xba1c, 0xba4e], [0xba71, 0xba92], [0xbaa3, 0xbae4]];
    for (const [text, mouth] of lines) {
      if (yield* this.talk(anim, 0, 0xd, text, mouth, true)) break;
    }
    this.firstIntro = false;
    yield () => this.inkey() === 0;
  }

  // ------------------------------------------------- craft selection

  /**
   * sub_2D24: choose one of five craft. Each craft keeps its own home
   * position (DS:0x4240); the chosen one swaps homes with the centre craft,
   * flies forward to the front and is drawn in its normal colours while the
   * others use their red variants. Space cycles, Enter accepts.
   */
  *craftSelect() {
    const app = this.app, d = this.display, ds = this.ds, g = this.arena;
    d.clear(); d.blit();
    this.studio(); d.animFrame(this.data.anims.ANIM1V, 0);
    yield* this.talk(this.data.anims.ANIM1V, 0, 0xd, 0xbc19, 0xbc32, false);
    this.kb.clearLatches();
    const craft = [];
    for (let i = 0; i < 5; i++) {
      const b = 0x4240 + i * 12;
      const x = ds.s16(b), y = ds.s16(b + 2);
      craft.push({ hx: x, hy: y, x, y, z: ds.s16(b + 4), model: ds.u16(b + 6), vx: ds.s16(b + 8), vy: ds.s16(b + 10), yaw: 0 });
    }
    let sel = this.craftSlot;
    const swapHome = (a, b) => {
      for (const k of ['hx', 'hy', 'x', 'y', 'z', 'vx', 'vy']) { const t = craft[a][k]; craft[a][k] = craft[b][k]; craft[b][k] = t; }
    };
    swapHome(sel, 2);
    craft[sel].model -= 2;
    let typing = 1;
    const select = (next) => {
      craft[sel].model += 2;
      for (const k of ['hx', 'hy', 'vx', 'vy']) craft[sel][k] = craft[next][k];
      app.speaker.request(0x0f05);
      typing = 1;
      sel = next;
      craft[sel].model -= 2;
    };
    const o = g.o, slot = 23;
    for (;;) {
      // sub_2E8C
      for (let i = 0; i < 5; i++) {
        const c = craft[i];
        c.yaw = (c.yaw + 5) & 0xffff;
        if (i !== sel) {
          c.x += c.vx; c.y += c.vy;
          const z = s16(c.z + 0xf);
          if (z < 0) c.z = z; else { c.x = c.hx; c.y = c.hy; c.z = 0; }
        } else {
          c.x -= c.vx; c.y -= c.vy;
          const z = u16(c.z - 0xa);
          if (z > 0xff9c) c.z = s16(z); else { c.x = 0; c.y = -0x46; c.z = -100; }
        }
      }
      const prims = [];
      const cam = (g.camYaw >> 8) & 0xff;
      const draw = (i) => {
        const c = craft[i];
        o.vxv[slot] = u16(c.x); o.vyv[slot] = u16(c.y); o.vzv[slot] = u16(c.z);
        o.model[slot] = c.model; o.yaw[slot] = c.yaw; o.pitch[slot] = 0; o.roll[slot] = 0;
        this.scene.object(g, slot, this.scene.light(cam), prims);
      };
      for (let i = 0; i < 5; i++) if (i !== sel) draw(i);
      draw(sel);
      app.renderer.setPrimitives(prims, 0, 'black');
      d.clear();
      if (typing < 0x64) typing++;
      if (!d.print(4, 1, 1, ds.cstr(ds.u16(0x4288 + sel * 2)), typing)) app.speaker.request(0x0032);
      app.speaker.flush();
      this.craftRatings(sel);
      app.showOverlay3D(d.work);
      yield 2;
      if (this.kb.take(SC_SPACE)) select((sel + 1) % 5);
      if (this.kb.take(SC_ENTER)) break;
    }
    this.craftSlot = sel;
    g.selectCraft(sel);
    d.clear(); d.blit();
    app.renderer.setPrimitives([], 0, 'sky');
  }

  /** sub_ADFA: SPEED / ACCEL / TURN ratings of the highlighted craft. */
  craftRatings(craft) {
    const d = this.display, ds = this.ds;
    d.print(6, 1, 0xe, ds.cstr(0xbe29));
    const si = craft * 2, colour = ds.u16(0xae10);
    d.num3(8, 0xe, ds.u16(0x9c + si) + 1, 8, colour);
    d.num3(0x12, 0xe, ds.u16(0x92 + si) + 1, 8, colour);
    d.num3(0x1b, 0xe, ds.u16(0xa6 + si) + 1, 8, colour);
  }

  // -------------------------------------------------- round screens

  /** sub_ABEF: pilot briefing before each round. */
  *roundIntro() {
    const d = this.display, g = this.arena, ds = this.ds;
    const arena = Math.floor(g.round / 10), first = g.round % 10 === 0;
    this.craftPanel();                        // ad71
    d.picture(this.data.images.PILOTV, 0, 0, 0xec);
    const anim = this.data.anims.ANIM2V;
    if (first) {
      d.printShadow(0xc, 0, 1, ds.cstr(0xbda4));
      d.num2(0x19, 1, g.round, 0xc);
      d.printShadow(0xc, 0, 3, ds.cstr(0xbdc0));
      d.printShadow(0xc, 0x15, 3, ds.cstr(ds.u16(0xae28 + arena * 2)));
    } else {
      d.printShadow(0xc, 0, 1, ds.cstr(0xbde1));
      d.num2(0x19, 1, g.round, 0xc);
    }
    for (let f = 0; f < 8; f++) { d.animFrame(anim, f); d.blit(); yield 3; }
    d.printShadow(0xc, 0, 0xe, ds.cstr(0xbdfd));
    d.permille(0x16, 0xe, ds.u16(0x42e5), 0xc);
    d.blit();
    yield* this.playTune(3);
    yield* this.pause(5, 0x3e8);
  }

  /** sub_AD71: the craft's ratings drawn with the 6x8 font on the panel buffer. */
  craftPanel() {
    const d = this.display, g = this.arena, ds = this.ds;
    d.clear();
    d.print6(2, 0, 0, ds.cstr(0xbe14));
    const colour = ds.u16(0xae10);
    d.num3(6, 1, g.craft.speed + 1, 6, colour);
    d.num3(6, 0, g.craft.accel + 1, 6, colour);
    d.num3(6, 2, g.craft.turn + 1, 6, colour);
    // sub_4A00: copy the 56x24 block at the buffer's origin into the panel's centre screen
    const app = this.app;
    for (let y = 0; y < 0x18; y++) for (let x = 0; x < 7 * 8; x++) {
      app.screen.plot(0x10 * 8 + x, 0xa7 + y, d.work.d[y * 256 + x]);
    }
  }

  /** sub_A9FB: end of round. */
  *roundComplete() {
    const d = this.display, g = this.arena, ds = this.ds;
    const arena = Math.floor(g.round / 10);
    if (g.round % 10 !== 9) {
      d.clear();
      this.studio(); d.animFrame(this.data.anims.ANIM1V, 0);
      d.printShadow(4, 0, 0xd, ds.cstr(0xbca3));
      d.printShadow(4, 0, 0xd, ds.cstr(0xbcbd));
      d.num2(0xd, 0xd, g.round, 2);
      d.printShadow(4, 9, 0xe, ds.cstr(0xbcd7));
      d.printShadow(4, 0x10, 0xe, ds.cstr(ds.u16(0xae28 + arena * 2)));
      yield* this.talk(this.data.anims.ANIM1V, 0, 0, 0xbcde, 0xbcdf, false);
      yield* this.playTune(4);
      yield* this.pause(0, 0xc8);
      yield* this.stats();
      return;
    }
    // arena completed: trophy
    d.picture(this.data.images.AWARDV, 0, 0, 0xec);
    d.printShadow(0xe, 0, 2, ds.cstr(0xbcfd));
    d.printShadow(0xe, 0, 0xd, ds.cstr(0xbd1e));
    d.printShadow(0xe, 0x14, 0xd, ds.cstr(ds.u16(0xae28 + arena * 2)));
    d.blit();
    yield* this.playTune(4);
    yield* this.pause(0, 0x15e);
    d.clear(); d.blit();
    d.print(0xe, 0, 2, ds.cstr(0xbd3f));
    d.print(1, 0, 0xd, ds.cstr(ds.u16(0xae32 + arena * 2)));
    d.picture(this.data.images[`TR${arena}V`], 0x40, 0x20, 0xec);
    d.blit();
    yield* this.playTune(2);
    yield* this.pause(5, 0x15e);
    yield* this.stats();
  }

  /** sub_ADEA: the results pages. */
  *stats() {
    const g = this.arena, ds = this.ds;
    computeRates(g, ds);                         // 138d
    yield* this.graphs();                        // a5b9
    yield* this.craftStatus();                   // af37
    yield* this.defenceAssessment();             // b3bc
    yield* this.hitAssessment();                 // b54f
  }

  /** sub_A5B9: per-round history graphs of hit, defence and video rates. */
  *graphs() {
    const d = this.display, g = this.arena, ds = this.ds, h = this.history ?? (this.history = { hit: new Uint8Array(50), def: new Uint8Array(50), vid: new Uint8Array(50) });
    d.clear();
    for (let r = g.round + 1; r < 50; r++) { h.hit[r] = 0; h.def[r] = 0; h.vid[r] = 0; }
    h.hit[g.round] = Math.trunc(g.rates.roundHit / 10);
    h.def[g.round] = Math.trunc(g.rates.roundDef / 10);
    h.vid[g.round] = Math.trunc(g.rates.roundVid / 10);
    const box = (x0, y0, w, hgt, nx, ny) => {
      for (let i = 0; i <= nx; i++) { const x = x0 + Math.trunc((i * w) / nx); d.work.line(x, y0, x, y0 + hgt, 1); }
      for (let j = 0; j <= ny; j++) { const y = y0 + Math.trunc((j * hgt) / ny); d.work.line(x0, y, x0 + w, y, 1); }
    };
    const plot = (x0, y0, w, hgt, arr, n, colour) => {
      let x = x0, y = y0 + hgt - Math.trunc((arr[0] * hgt) / 100);
      d.work.line(x - 1, y - 1, x + 1, y + 1, colour); d.work.line(x - 1, y + 1, x + 1, y - 1, colour);
      for (let i = 1; i < n; i++) {
        const nx = x0 + Math.trunc((i * w) / 50), ny = y0 + hgt - Math.trunc((arr[i] * hgt) / 100);
        d.work.line(x, y, nx, ny, colour); x = nx; y = ny;
      }
    };
    box(2, 5, 0xfa, 0x1e, 10, 10); plot(2, 5, 0xfa, 0x1e, h.hit, g.round + 1, 2);
    box(2, 0x2d, 0xfa, 0x1e, 10, 10); plot(2, 0x2d, 0xfa, 0x1e, h.def, g.round + 1, 3);
    box(2, 0x55, 0xfa, 0x1e, 10, 10); plot(2, 0x55, 0xfa, 0x1e, h.vid, g.round + 1, 4);
    d.print(2, 0xc, 1, ds.cstr(0xbc88));
    d.print(3, 0xc, 6, ds.cstr(0xbc91));
    d.print(4, 0xc, 0xb, ds.cstr(0xbc9a));
    d.blit();
    yield* this.pause(5, 0x1770);
  }

  /** sub_AE80: craft and rates block shared by the result pages. */
  craftBlock() {
    const d = this.display, g = this.arena, ds = this.ds;
    d.clear();
    d.print(4, 0, 1, ds.cstr(ds.u16(0xae12)));
    d.num3(0xf, 4, g.craft.accel + 1, 8, 2);
    d.num3(0xf, 5, g.craft.speed + 1, 8, 2);
    d.num3(0xf, 6, g.craft.turn + 1, 8, 2);
    d.permille(0x19, 4, g.rates.roundHit, 2);
    d.permille(0x19, 5, g.rates.roundDef, 2);
    d.permille(0x19, 6, g.rates.roundVid, 2);
    d.print(2, 0xf, 3, ds.cstr(ds.u16(0x4288 + g.craft.index * 2)));
  }

  /** sub_AF37 */
  *craftStatus() {
    const d = this.display, g = this.arena, ds = this.ds;
    this.craftBlock();
    d.print(4, 0, 8, ds.cstr(ds.u16(0xae14)));
    d.num2(0xf, 8, Math.trunc((g.shield * 0x63) / 0x1f), 2);
    d.num2(0xf, 9, g.defenders, 2);
    d.num2(0xf, 0xa, g.turbos, 2);
    d.num2(0xf, 0xb, g.twinShots, 2);
    d.num2(0xf, 0xc, g.powerShots, 2);
    this.sfx(0xf);
    d.blit();
    yield* this.pause(5, 0x2ee);
  }

  /** sub_B3BC */
  *defenceAssessment() {
    const d = this.display, g = this.arena, ds = this.ds, c = g.craft;
    const page = () => { this.craftBlock(); d.print(4, 0, 8, ds.cstr(ds.u16(0xae16))); d.permille(0x19, 0xb, g.rates.roundDef, 2); };
    page(); this.sfx(0xf); d.blit();
    yield* this.pause(5, 0x32);
    if (g.rates.roundDef === 1000) {
      d.print(2, 1, 0xc, ds.cstr(0xbe44)); this.sfx(8); d.blit();
      yield* this.pause(5, 0x32);
      page(); this.sfx(8); d.print(2, 1, 0xc, ds.cstr(0xbe5c)); d.blit();
    } else {
      this.sfx(8); d.print(2, 1, 0xc, ds.cstr(0xbe73)); d.blit();
      const tag = ds.u16(0xae44);
      ds.w8(tag, 0x2d);
      yield* this.pause(5, 0x32);
      for (let si = 5; si >= 0; si--) {
        if (si !== 5) { c.accel = Math.max(0, c.accel - 1); c.speed = Math.max(0, c.speed - 1); c.turn = Math.max(0, c.turn - 1); }
        page();
        d.print(2, 1, 0xc, ds.cstr(0xbe85));
        ds.w8(tag + 1, 0x30 + si);
        for (const row of [4, 5, 6]) d.print(3, 0x12, row, ds.cstr(tag));
        this.sfx(0); d.blit();
        yield* this.pause(0, 0xa);
      }
      g.deriveCraft();
    }
    yield* this.pause(5, 0x96);
  }

  /** sub_B54F: hit rate against the best five so far (DS:0x42E5). */
  *hitAssessment() {
    const d = this.display, g = this.arena, ds = this.ds, c = g.craft;
    const best = ds.u16(0x42ed), target = ds.u16(0x42e5);
    const page = () => { this.craftBlock(); d.print(4, 0, 8, ds.cstr(ds.u16(0xae18))); d.permille(0x19, 0xa, best, 2); d.permille(0x19, 0xb, target, 2); d.permille(0x19, 0xc, g.rates.roundHit, 2); };
    page(); this.sfx(0xf); d.blit();
    yield* this.pause(5, 0x32);
    const rank = insertHitRate(ds, g.rates.roundHit);   // 2fee
    if (rank === 0) {
      d.print(2, 1, 0xd, ds.cstr(0xbea2)); this.sfx(8); d.blit();
      yield* this.pause(5, 0x32);
      page(); d.print(2, 1, 0xd, ds.cstr(0xbeb8)); this.sfx(8); d.blit();
    } else {
      d.print(2, 1, 0xd, ds.cstr(0xbecd)); this.sfx(8); d.blit();
      const tag = ds.u16(0xae44);
      ds.w8(tag, 0x2b);
      yield* this.pause(5, 0x32);
      for (let si = 5; si >= 0; si--) {
        if (si !== 5) { c.accel = Math.min(0x63, c.accel + 1); c.speed = Math.min(0x63, c.speed + 1); c.turn = Math.min(0x63, c.turn + 1); }
        page();
        d.print(2, 1, 0xd, ds.cstr(0xbee1));
        ds.w8(tag + 1, 0x30 + si);
        for (const row of [4, 5, 6]) d.print(3, 0x12, row, ds.cstr(tag));
        d.blit(); this.sfx(0);
        yield* this.pause(0, 0xa);
      }
      g.deriveCraft();
    }
    yield* this.pause(5, 0x96);
  }

  /** sub_2B34 / sub_2B6A: the contract is terminated. */
  *gameOver(textOff, picture) {
    const d = this.display, ds = this.ds;
    d.picture(picture, 0, 0, 0xec);
    d.printShadow(0xe, 0, 0xc, ds.cstr(textOff));
    d.blit();
    yield* this.playTune(1);
    const text = ds.cstr(0x1045);
    for (let n = 1; n <= text.length; n++) {
      d.printShadow(0xe, 0, 0xe, text, n);
      d.blit();
      if (text.charCodeAt(n - 1) > 0x20) { this.app.speaker.request(0x0032); this.app.speaker.flush(); }
      yield 3;
    }
    yield* this.pause(5, 0x1f4);
  }

  // ---------------------------------------------------- attract mode

  /** sub_9230: the computer flies about for 0x4B0 frames or until a key. */
  *attractDemo() {
    const app = this.app, g = this.arena;
    this.craftSlot = this.craftSlot ?? 0;
    g.selectCraft(this.craftSlot);
    g.newGame();
    this.applyArenaLook();
    const demo = { turnTimer: 1, target: 0 };
    let key = false;
    let quarter = 0, holdQ = 0, pick = 0, sel = 0;
    for (let n = 0x4b0; n > 0 && !key; n--) {
      yield () => app.frameTicks >= 5;
      app.frameTicks = 0;
      // 9318: random autopilot, always thrusting
      if (--demo.turnTimer < 0) { demo.turnTimer = (g.rng.next() & 0xf) + 0xc; demo.target = g.rng.next() & 0xf0; }
      let x = g.input.x ?? 0x80;
      if (x !== demo.target) x += x < demo.target ? 0x10 : -0x10;
      Object.assign(g.input, { x: x & 0xff, y: 0x80, buttons: 1, fireLatch: 0, thrustLatch: 0 });
      g.updatePlayer(); g.updateCameraYaw(); g.updateCameraHeight();
      g.o.roll[0] = (g.o.roll[0] & 0xff00) | (((-g.p.turn) << 2 >> 8) & 0xff);
      aiRun(g); g.moveObjects(); g.sampleGround();
      this.renderFrame();
      // 934d: the picture is shown in flickering quarters like a bad TV signal
      if (--holdQ < 0) {
        holdQ = 0xa;
        if (--pick < 0) { pick = g.rng.next() & 0x1f; sel = g.rng.next() & 7; }
        quarter = (quarter + 1) & 3;
        const table = sel <= 3 ? 0xa7be : sel === 4 ? 0xa7ba : sel === 5 ? 0xa7b6 : 0xa7b2;
        app.renderer.quarters = this.ds.u8(table + quarter);
      }
      key = this.inkey() !== 0;
    }
    app.renderer.quarters = 0xf;
    this.kb.clearLatches();
    return key;
  }
}

/** sub_138D: hit, defence and video rates in tenths of a percent. */
export function computeRates(g, ds) {
  // sub_1426: shift both 32-bit values left until either high word has its top bit set,
  // then divide the high words: a*1000/b with the original's precision
  const rate = (a, b) => {
    a >>>= 0; b >>>= 0;
    if (!b) return 0;
    while (!(((a >>> 16) | (b >>> 16)) & 0x8000)) { a = (a * 2) >>> 0; b = (b * 2) >>> 0; }
    const bh = b >>> 16;
    return bh ? Math.floor(((a >>> 16) * 1000) / bh) & 0xffff : 0;
  };
  const s = g.stats;
  const r = s.round, a = s.arena, gm = s.game;
  g.rates = {
    roundHit: rate(r.hits, r.shots), roundDef: rate(r.def, r.defMax), roundVid: rate(r.vid, r.vidMax),
    arenaHit: rate(a.hits + r.hits, a.shots + r.shots), arenaDef: rate(a.def + r.def, a.defMax + r.defMax), arenaVid: rate(a.vid + r.vid, a.vidMax + r.vidMax),
    gameHit: rate(gm.hits + r.hits, gm.shots + r.shots), gameDef: rate(gm.def + r.def, gm.defMax + r.defMax), gameVid: rate(gm.vid + r.vid, gm.vidMax + r.vidMax),
  };
  // the stats strings in DS ("Hit: XXX.X%") are patched like sub_1461
  const put = (off, v) => {
    const t = [0x20, 0x20, 0x30, 0x2e, 0x30];
    let x = v, i = 4;
    do { const dgt = x % 10; x = Math.floor(x / 10); if (i === 3) i--; t[i] = 0x30 + dgt; i--; } while (x > 0 && i >= 0);
    for (let k = 0; k < 5; k++) ds.w8(off + k, t[k]);
  };
  put(0x10ba, g.rates.roundHit); put(0x10c6, g.rates.roundDef); put(0x10d2, g.rates.roundVid);
  put(0x10eb, g.rates.arenaHit); put(0x10f7, g.rates.arenaDef); put(0x1103, g.rates.arenaVid);
  put(0x111b, g.rates.gameHit); put(0x1127, g.rates.gameDef); put(0x1133, g.rates.gameVid);
}

/** sub_2FEE: insert this round's hit rate into the sorted best-five table; returns its rank. */
function insertHitRate(ds, v) {
  ds.w16(0x42e3, v);
  let rank = 0;
  for (let i = 0; i < 5; i++) {
    const at = 0x42e5 + i * 2;
    const cur = ds.u16(at);
    if (v <= cur) break;
    ds.w16(at - 2, cur);
    ds.w16(at, v);
    rank++;
  }
  return rank;
}

/** sub_7F36: printable name of a scancode. */
function keyName(ds, sc) {
  const c = ds.u8(0xa1c6 + sc);
  if (c & 0x80) return '?';
  if (c >= 0x61 && c <= 0x7a) {
    let p = 0xa246, n = c - 0x61;
    while (n > 0) { if (ds.u8(p) === 0) n--; p++; }
    return ds.cstr(p);
  }
  return String.fromCharCode(c);
}
