/**
 * Game flow. Each screen is a small state machine driven by 50 Hz ticks;
 * the arena runs one game frame every five ticks like the main loop at
 * CS:22C1 (which waits for cs:81E8 >= 5).
 */
import { Arena } from './game/arena.js';
import { SceneBuilder } from './render/scene.js';
import { Hud } from './render/hud.js';

export class Flow {
  constructor(app) {
    this.app = app;
    this.data = app.data;
    this.state = null;
    this.arena = null;
    this.scene = new SceneBuilder(app.data);
    this.hud = new Hud(app.data);
    this.go(new ArenaState(this));
  }
  go(state) { this.state = state; state.enter?.(); }
  tick() { this.state?.tick(); }
}

/** In-game: arena logic + rendering at 10 Hz. */
export class ArenaState {
  constructor(flow, { craft = 0, newGame = true } = {}) {
    this.flow = flow;
    this.app = flow.app;
    this.craft = craft;
    this.newGame = newGame;
  }

  enter() {
    const app = this.app, data = app.data;
    const sound = app.speaker;
    if (!this.flow.arena) this.flow.arena = new Arena(data, sound);
    const g = this.flow.arena;
    g.selectCraft(this.craft);
    if (this.newGame) g.newGame();
    this.loadArenaLook();
    app.frameTicks = 0;
  }

  /** Panel picture, base palette and the arena's sky (sub_5DC6, 5D5C, 61AD). */
  loadArenaLook() {
    const app = this.app, data = app.data, g = this.flow.arena;
    const panel = data.images.P_VGA;
    app.screen.blit(panel);
    app.setColours(panel.firstColour, panel.palette);
    app.setColours(0x10, data.palette.dac.subarray(0x30, 0x30 + 0x70 * 3));
    app.setColours(0x80, data.skies[g.arena]);
    this.skyArena = g.arena;
    app.renderer.showView = true;
    this.flow.hud.counters(g, app.screen);
  }

  tick() {
    const app = this.app;
    if (app.frameTicks < 5) return;
    app.frameTicks = 0;
    const g = this.flow.arena;
    app.controls.read(g.input);
    g.input.refuel = app.keyboard.held(0x43);
    const ev = g.step();
    if (ev === 'cleared') {
      g.nextRound();
      if (g.arena !== this.skyArena) this.loadArenaLook();
      this.flow.hud.counters(g, app.screen);
      return;
    }
    if (ev) { g.newGame(); this.loadArenaLook(); return; }
    this.render(g);
  }

  render(g) {
    const app = this.app, flow = this.flow;
    app.speaker.flush();
    g.hudPhase();
    const prims = flow.scene.build(g);
    app.renderer.setPrimitives(prims, g.groundColour ?? 0);
    flow.hud.draw(g, flow.scene, app.view, app.screen, () => app.speaker.request(0x0764));
    flow.hud.counters(g, app.screen);
  }
}
