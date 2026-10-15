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
    this.steer = 0x80;   // [0x9FF2] keyboard steering accumulator; [0x9FEA] (x) is what the game reads
    this.repeat = 0; this.repeatAcc = 0;
    // mouse position as int 33h reports it (range 0..0xFF on both axes, set by sub_7C7F)
    this.mouse = { x: 0x80, y: 0x80, buttons: 0, down: 0, pressed: [0, 0] };
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

  /** Called once per game frame (the original reads controls at the start of the player update). */
  read(input) {
    if (this.mode === 'mouse') return this.readMouse(input);
    const kb = this.kb, k = this.keys;
    if (kb.held(k.left)) this.turnRate = -0x1f;
    else if (kb.held(k.right)) this.turnRate = 0x1f;
    else {
      this.turnRate = 0;
      // recentre by 0x1F a frame
      if (this.steer > 0x80) { this.steer -= 0x1f; if (this.steer <= 0x80) this.steer = 0x80; }
      else { this.steer += 0x1f; if (this.steer > 0x80) this.steer = 0x80; }
    }
    this.steer = Math.max(0, Math.min(0xff, this.steer + this.turnRate));
    this.x = this.steer;
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
