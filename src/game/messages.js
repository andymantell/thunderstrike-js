/**
 * The 13-line status message system (sub_0EED posts, sub_0E7C draws).
 *
 * A post is (si, bp, bx) exactly like the original call:
 *   si low byte  = slot*2, high byte = flags (bit7 beep, bits0-6 blink mask)
 *   bp           = DS offset of the NUL-terminated text
 *   bx           = frames to show; values with the top bit set never expire
 * Slot positions (row, column in 8x8 cells of the 3D view) come from
 * DS:0x183B.
 */
export const MSG = { ROUND: 0x16 };
const SLOTS = 13;

export class Messages {
  constructor(exe) {
    this.ds = exe.ds;
    this.timer = new Uint16Array(SLOTS);
    this.text = new Uint16Array(SLOTS);
    this.blink = new Uint8Array(SLOTS);
    this.beep = new Uint8Array(SLOTS);
    this.pos = [];
    for (let i = 0; i < SLOTS; i++) this.pos.push(this.ds.u16(0x183b + i * 2));
    this.counter = 0;
  }

  clear() { this.timer.fill(0); }

  post(si, bp, bx) {
    const slot = (si & 0xff) >> 1;
    if (slot >= SLOTS) return;
    const flags = (si >> 8) & 0xff;
    this.text[slot] = bp;
    this.timer[slot] = bx & 0xffff;
    this.blink[slot] = flags & 0x7f;
    this.beep[slot] = flags & 0x80;
  }

  /**
   * sub_0E7C: called once per rendered frame. Returns the lines to draw as
   * { row, col, text } and invokes beep() for beeping lines.
   */
  frame(beep) {
    this.counter = (this.counter + 1) & 0xf;
    const out = [];
    for (let i = 0; i < SLOTS; i++) {
      let t = this.timer[i];
      if (t === 0) continue;
      t = (t - 1) & 0xffff;
      if (!(t & 0x8000)) {
        this.timer[i] = t;
        if (this.blink[i] & this.counter) continue;
      }
      const p = this.pos[i];
      out.push({ row: p >> 8, col: p & 0xff, text: this.ds.cstr(this.text[i]) });
      if (this.beep[i]) beep();
    }
    return out;
  }
}
