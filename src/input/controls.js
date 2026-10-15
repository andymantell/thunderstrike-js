/**
 * Controller emulation producing the original's abstract controls:
 *   x, y        0..255 axes (0x80 centre)     [0x9FEA],[0x9FEC]
 *   buttons     bit0 thrust, bit1 fire          [0x9FE8]
 *   fireLatch / thrustLatch: new presses        [0x9FEE],[0x9FF0]
 * Keyboard mode follows sub_7E04, mouse mode sub_7BDB.
 */
/**
 * Key layouts offered in the settings, by PC scancode. 'original' is the
 * game's own default (DS:0x9FDC: Z/X turn, P thrust, Space fire, L/, climb
 * and dive); the game's options menu can still redefine any of them.
 */
export const KEY_LAYOUTS = {
  arrows: { left: 0x4b, right: 0x4d, thrust: 0x48, fire: 0x39, up: 0x1e, down: 0x2c },   // arrows, Space, A/Z
};

export class Controls {
  constructor(keyboard, ds) {
    this.kb = keyboard;
    this.mode = 'keyboard';
    // default key scancodes DS:0x9FDC: left, right, thrust, fire, up, down
    this.originalKeys = { left: ds.u16(0x9fdc), right: ds.u16(0x9fde), thrust: ds.u16(0x9fe0), fire: ds.u16(0x9fe2), up: ds.u16(0x9fe4), down: ds.u16(0x9fe6) };
    this.keys = { ...this.originalKeys };
    this.onKeysRedefined = null;   // the settings remember keys set in the game's options menu
    this.x = 0x80; this.y = 0x80; this.turnRate = 0;
    this.steer = 0x80;   // [0x9FF2] keyboard steering accumulator; [0x9FEA] (x) is what the game reads
    this.repeat = 0; this.repeatAcc = 0;
    // the steering curve (sub_25C1's table at [0x3E16]) gives no turn across its middle; its edges
    const curve = ds.u16(0x3e16);
    this.deadLo = 0x80; while (this.deadLo > 0 && ds.u8(curve + this.deadLo - 1) === 0) this.deadLo--;
    this.deadHi = 0x80; while (this.deadHi < 0xff && ds.u8(curve + this.deadHi + 1) === 0) this.deadHi++;
    // mouse position as int 33h reports it (range 0..0xFF on both axes, set by sub_7C7F)
    this.mouse = { x: 0x80, y: 0x80, buttons: 0, down: 0, pressed: [0, 0], seen: false };
    // mouse options (sub_A056): speeds [0xA002],[0xA004] 0..0x32, reverse height [0x9FFE], swap buttons [0xA000]
    this.mouseSpeed = [ds.u16(0xa002), ds.u16(0xa004)];
    this.invertY = ds.u16(0x9ffe) !== 0;
    this.swapButtons = ds.u16(0xa000) !== 0;
  }

  /**
   * sub_7CD0 passes speed+25 to int 33h function 1Ah, whose default is 50.
   * Treated as a linear multiplier of the default rate.
   */
  mouseScale(axis) { return (this.mouseSpeed[axis] + 0x19) / 50; }

  /** Buttons as int 33h function 3 reports them (a press between two polls still counts). */
  mouseButtons() {
    const m = this.mouse, b = m.buttons | m.down;
    m.down = 0;
    return b;
  }

  /**
   * Whether menus show the pointer and take clicks: always with mouse
   * control (as the original), and with keyboard control once the mouse has
   * been moved over the game (a convenience the original did not have).
   */
  pointerShown() { return this.mode === 'mouse' || this.mouse.seen; }

  /** A click since the last look, for "press a key" waits. */
  takeClick() { const m = this.mouse, d = m.down; m.down = 0; return d !== 0; }

  /** sub_9E12: menu pointer (height never reversed), clamped to the 256x128 window. */
  pointer() {
    const m = this.mouse;
    return { x: Math.min(m.x | 0, 0xf0), y: Math.min(m.y | 0, 0x70), buttons: this.mouseButtons() & 3 };
  }

  /** [0x9FFC]: sub_7F29 centres the keyboard axes; sub_7C7F puts the mouse back at (0x80, 0x80). */
  reset() {
    this.x = 0x80; this.y = 0x80;      // not [0x9FF2]: steering keeps its lean
    if (this.mode === 'mouse') { this.mouse.x = 0x80; this.mouse.y = 0x80; }
  }

  /**
   * Called once per game frame (the original reads controls at the start of
   * the player update). The enhanced mode's faster game reads them each pass
   * with `part` the fraction of a frame, so the keyboard axes move that much.
   *
   * `responsive` (the enhanced mode): the turn keys skip the curve's dead
   * zone, which the original's stick has to cross a step a frame (0.3 s
   * before a turn starts, 0.7 s to reverse one); letting go centres at once.
   * The climb to full turn beyond it is the original's.
   */
  read(input, part = 1, responsive = false) {
    if (this.mode === 'mouse') return this.readMouse(input);
    const kb = this.kb, k = this.keys, step = 0x1f * part;
    if (kb.held(k.left)) {
      this.turnRate = -step;
      if (responsive) this.steer = Math.min(this.steer, this.deadLo);
    } else if (kb.held(k.right)) {
      this.turnRate = step;
      if (responsive) this.steer = Math.max(this.steer, this.deadHi);
    } else if (responsive) {
      this.turnRate = 0;
      this.steer = 0x80;
    } else {
      this.turnRate = 0;
      // recentre by 0x1F a frame
      if (this.steer > 0x80) { this.steer -= step; if (this.steer <= 0x80) this.steer = 0x80; }
      else { this.steer += step; if (this.steer > 0x80) this.steer = 0x80; }
    }
    this.steer = Math.max(0, Math.min(0xff, this.steer + this.turnRate));
    this.x = this.steer;
    const up = kb.held(k.up), down = kb.held(k.down);
    if (up || down) {
      this.repeat = 0; this.repeatAcc = 0;
      if (up) this.y = Math.max(0, this.y - 0x10 * part);
      else this.y = Math.min(0xff, this.y + 0x10 * part);
    }
    let buttons = 0;
    if (kb.held(k.thrust)) buttons |= 1;
    if (kb.held(k.fire)) buttons |= 2;
    input.x = this.x; input.y = this.y; input.buttons = buttons;
    input.fireLatch = kb.take(k.fire);
    input.thrustLatch = kb.take(k.thrust);
  }

  /** sub_7BDB: mouse X steers, mouse Y sets altitude, left button thrust, right button fire. */
  readMouse(input) {
    const m = this.mouse;
    input.x = m.x & 0xff;
    input.y = this.invertY ? 0xff - (m.y & 0xff) : m.y & 0xff;
    let buttons = this.mouseButtons();
    input.fireLatch = m.pressed[0]; input.thrustLatch = m.pressed[1];
    m.pressed[0] = m.pressed[1] = 0;
    if (this.swapButtons) {
      [input.fireLatch, input.thrustLatch] = [input.thrustLatch, input.fireLatch];
      buttons = ((buttons & 1) << 1) | ((buttons & 2) >> 1);
    }
    input.buttons = buttons;
  }
}
