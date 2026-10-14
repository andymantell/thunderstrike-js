/**
 * Controller emulation producing the original's abstract controls:
 *   x, y        0..255 axes (0x80 centre)     [0x9FEA],[0x9FEC]
 *   buttons     bit0 thrust, bit1 fire          [0x9FE8]
 *   fireLatch / thrustLatch: new presses        [0x9FEE],[0x9FF0]
 * Keyboard mode follows sub_7E04, mouse mode sub_7BDB.
 */
export class Controls {
  constructor(keyboard, ds) {
    this.kb = keyboard;
    this.mode = 'keyboard';
    // default key scancodes DS:0x9FDC: left, right, thrust, fire, up, down
    this.keys = { left: ds.u16(0x9fdc), right: ds.u16(0x9fde), thrust: ds.u16(0x9fe0), fire: ds.u16(0x9fe2), up: ds.u16(0x9fe4), down: ds.u16(0x9fe6) };
    this.x = 0x80; this.y = 0x80; this.turnRate = 0;
    this.repeat = 0; this.repeatAcc = 0;
    this.mouse = { x: 0x80, y: 0x80, buttons: 0, pressed: [0, 0] };
  }

  reset() { this.x = 0x80; this.y = 0x80; this.turnRate = 0; }

  /** Called once per game frame (the original reads controls at the start of the player update). */
  read(input) {
    if (this.mode === 'mouse') return this.readMouse(input);
    const kb = this.kb, k = this.keys;
    if (kb.held(k.left)) this.turnRate = -0x1f;
    else if (kb.held(k.right)) this.turnRate = 0x1f;
    else {
      this.turnRate = 0;
      // recentre by 0x1F a frame
      if (this.x > 0x80) { this.x -= 0x1f; if (this.x <= 0x80) this.x = 0x80; }
      else { this.x += 0x1f; if (this.x > 0x80) this.x = 0x80; }
    }
    let x = this.x + this.turnRate;
    this.x = Math.max(0, Math.min(0xff, x));
    const up = kb.held(k.up), down = kb.held(k.down);
    if (up || down) {
      this.repeat = 0; this.repeatAcc = 0;
      if (up) this.y = Math.max(0, this.y - 0x10);
      else this.y = Math.min(0xff, this.y + 0x10);
    }
    let buttons = 0;
    if (kb.held(k.thrust)) buttons |= 1;
    if (kb.held(k.fire)) buttons |= 2;
    input.x = this.x; input.y = this.y; input.buttons = buttons;
    input.fireLatch = kb.take(k.fire);
    input.thrustLatch = kb.take(k.thrust);
  }

  /** sub_7BDB: mouse X steers, mouse Y sets altitude, buttons thrust/fire. */
  readMouse(input) {
    const m = this.mouse;
    input.x = m.x & 0xff; input.y = m.y & 0xff;
    input.buttons = m.buttons;
    input.fireLatch = m.pressed[0]; input.thrustLatch = m.pressed[1];
    m.pressed[0] = m.pressed[1] = 0;
  }
}
