/**
 * PC-speaker sound effects, reimplementing the MZ.DAT driver (int 80h).
 *
 * Each effect is a 16-byte record at MZ.DAT:0x0A8E + id*16 that drives a
 * frequency sweep updated on every 50 Hz timer tick (driver routine 0x3CD):
 *   +0  s16 step        added to the divisor every tick
 *   +2  u16 divisor     initial PIT divisor
 *   +4  u16 reset       divisor reloaded when the period counter expires
 *   +6  s16 warbleA     \ added on accumulator overflow, alternating by
 *   +8  s16 warbleB     / rotating the warble pattern byte
 *   +10 u8  warblePat
 *   +11 u8  gatePat     rotated each tick, a set bit silences that tick
 *   +12 u8  duration    ticks (0 = until replaced)
 *   +13 u8  period      reload value for the counter (0 = no reset)
 *   +14 u8  accAdd      added to an 8-bit accumulator each tick
 *   +15 u8  counter
 * The game requests at most one effect per frame with a priority; lower
 * numbers win (sub_829C / sub_82A6).
 */
const PIT_HZ = 1193182;
const EFFECT_TABLE = 0x0a8e;

export class Speaker {
  constructor(mzBytes) {
    this.mz = mzBytes;
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.active = false;
    this.r = null;          // live copy of the effect record
    this.pending = 0xffff;  // [0xA630]
    this.current = 0xffff;  // [0xA632]
    this.muted = false;
    this.volume = 0.08;
  }

  /** Must be called from a user gesture before audio can start. */
  resume() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.osc = this.ctx.createOscillator();
      this.osc.type = 'square';
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.osc.connect(this.gain).connect(this.ctx.destination);
      this.osc.start();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  record(id) {
    const o = EFFECT_TABLE + id * 16, m = this.mz;
    const u16 = (k) => m[o + k] | (m[o + k + 1] << 8);
    return {
      step: u16(0), divisor: u16(2), reset: u16(4), warbleA: u16(6), warbleB: u16(8),
      warblePat: m[o + 10], gatePat: m[o + 11], duration: m[o + 12], period: m[o + 13],
      accAdd: m[o + 14], counter: m[o + 15], acc: 0xff,
    };
  }

  /** sub_829C: queue an effect; ax = (id << 8) | priority. */
  request(ax) {
    if ((ax & 0xff) > (this.pending & 0xff)) return;
    this.pending = ax;
  }

  /** sub_82A6: once per game frame, start the queued effect if allowed. */
  flush() {
    if ((this.pending & 0x8000) === 0) {
      if (!this.active || (this.pending & 0xff) <= (this.current & 0xff)) {
        this.current = this.pending;
        this.play(this.pending >> 8);
      }
    }
    this.pending = 0xffff;
  }

  play(id) { this.r = this.record(id & 0x1f); this.active = true; }
  stop() { this.active = false; this.silence(); }
  busy() { return this.active; }

  /** Driver tick (50 Hz). */
  tick() {
    let divisor = 1;
    const r = this.r;
    if (this.active && r) {
      if (r.duration !== 0 && --r.duration === 0) { this.active = false; this.silence(); return; }
      let dx = (r.divisor + r.step) & 0xffff;
      const ah = r.accAdd, al = r.period;
      const sum = r.acc + ah + (ah === 0xff ? 1 : 0);
      r.acc = sum & 0xff;
      if (sum > 0xff) {
        const bit = r.warblePat & 1;
        r.warblePat = ((r.warblePat >> 1) | (bit << 7)) & 0xff;
        dx = (dx + (bit ? r.warbleA : r.warbleB)) & 0xffff;
      }
      r.counter = (r.counter - 1) & 0xff;
      if (r.counter === 0) {
        r.counter = (r.counter + al) & 0xff;
        if (r.counter !== 0) dx = r.reset;
      }
      r.divisor = dx;
      const gate = r.gatePat & 1;
      r.gatePat = ((r.gatePat >> 1) | (gate << 7)) & 0xff;
      if (!gate) divisor = dx;
    }
    if (divisor <= 1) this.silence(); else this.tone(PIT_HZ / divisor);
  }

  tone(hz) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    this.osc.frequency.setValueAtTime(Math.min(hz, 20000), t);
    this.gain.gain.setValueAtTime(this.volume, t);
  }
  silence() { if (this.ctx) this.gain.gain.setValueAtTime(0, this.ctx.currentTime); }
}
