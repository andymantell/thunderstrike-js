/**
 * Keyboard state in the form the original's INT 9 handler (CS:7930) keeps
 * it: 128 bytes indexed by PC set-1 scancode, 0x00 while held and 0x80
 * when released, plus a "pressed since last read" latch per key.
 */
const CODE_TO_SCANCODE = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
  Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
  Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
  KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
  ControlLeft: 0x1d, ControlRight: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, AltRight: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Home: 0x47, Numpad8: 0x48, ArrowUp: 0x48,
  Numpad9: 0x49, PageUp: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, ArrowLeft: 0x4b, Numpad5: 0x4c,
  Numpad6: 0x4d, ArrowRight: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, End: 0x4f, Numpad2: 0x50,
  ArrowDown: 0x50, Numpad3: 0x51, PageDown: 0x51, Numpad0: 0x52, Insert: 0x52, NumpadDecimal: 0x53,
  Delete: 0x53, NumpadEnter: 0x1c, NumpadDivide: 0x35,
};

export class Keyboard {
  constructor(target = window) {
    this.state = new Uint8Array(128).fill(0x80);   // DS:0x9D80
    this.latch = new Uint8Array(128);              // DS:0x9E00
    this.last = 0;                                 // [0x9E80]
    this.ascii = [];                               // typed characters for text entry
    this.onAny = null;
    target.addEventListener('keydown', (e) => this.down(e));
    target.addEventListener('keyup', (e) => this.up(e));
    target.addEventListener('blur', () => this.state.fill(0x80));
  }
  scancode(e) { return CODE_TO_SCANCODE[e.code] ?? 0; }
  down(e) {
    const sc = this.scancode(e);
    if (!sc) return;
    e.preventDefault();
    if (this.state[sc] & 0x80) { this.last = sc; this.latch[sc] = 1; this.ascii.push(e.key); this.onAny?.(sc, e); }
    this.state[sc] = 0;
  }
  up(e) {
    const sc = this.scancode(e);
    if (!sc) return;
    e.preventDefault();
    this.state[sc] = 0x80;
  }
  held(sc) { return (this.state[sc] & 0x80) === 0; }
  /** read and clear a latch, like "mov al,[x]; xor [x],al" */
  take(sc) { const v = this.latch[sc]; this.latch[sc] = 0; return v; }
  anyLatched() { return this.latch.some((v) => v); }
  clearLatches() { this.latch.fill(0); this.ascii.length = 0; }
}

export const SC = { ESC: 0x01, ENTER: 0x1c, SPACE: 0x39, F1: 0x3b, F2: 0x3c, F9: 0x43, P: 0x19, Y: 0x15, N: 0x31 };
