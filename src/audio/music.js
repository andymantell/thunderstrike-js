/**
 * The MZ.DAT three-voice PC-speaker music player (int 80h AH=1 selects a
 * tune, AH=0 plays it until it ends or a key is pressed).
 *
 * The original bit-bangs the speaker from a tight loop that advances three
 * 24-bit phase accumulators and outputs, for each voice in turn,
 * (phase >> 16) < duty. A 54.6 Hz timer (PIT divisor 0x5555) runs the
 * sequencer. The synthesis loop runs as fast as the CPU allows; LOOP_RATE
 * models a period PC (it changes only the grain of the pulse widths).
 *
 * Selecting a tune (MZ.DAT:0x5A) first times the synthesis loop over one
 * 65536-count timer period and rebuilds the note table at 0x4C0..0x5BB
 * (over the credit text) from the twelve semitone steps at 0x48A, so the
 * notes come out at the same pitch whatever the CPU speed.
 */
const LOOP_RATE = 110000;
const SEQ_HZ = 1193182 / 0x5555;

const PROCESSOR = `
class MzMusic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mz = null; this.playing = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'load') this.mz = m.mz;
      else if (m.type === 'play') this.start(m.tune, m.loopRate, m.seqHz);
      else if (m.type === 'stop') this.playing = false;
    };
  }
  u8(o) { return this.mz[o & 0xffff] ?? 0; }
  u16(o) { return this.u8(o) | (this.u8(o + 1) << 8); }
  inc(bl) { return this.u8(0x4c0 + bl) | (this.u8(0x4c1 + bl) << 8) | (this.u8(0x4c2 + bl) << 16); }
  start(tune, loopRate, seqHz) {
    const rec = 0x67a + tune * 13;
    this.tempo = this.u8(rec);
    this.acc = 0xff;
    this.gTrans = 0x80;
    this.slide = 0;
    this.v = [];
    for (let k = 0; k < 3; k++) {
      const b = rec + 1 + k * 4;
      const seq = this.u16(b + 2);
      this.v.push({ ptr: this.u16(seq), len: 0, artic: 0, seq, end: this.u8(b), loop: this.u8(b + 1), pos: 0,
        trans: 0, dutyStart: 0, dutySweep: 0, rptr: 0, rcount: 0, count: 1, duty: 0, sweep: 0, inc: 0, phase: 0 });
    }
    this.v[2].inc = 0xff0000;
    this.loopStep = loopRate / sampleRate;
    this.seqStep = seqHz / sampleRate;
    this.seqClock = 1;
    this.loopClock = 0;
    this.playing = true;
  }
  next(v, k) {
    v.artic ^= 0x80;
    if (!(v.artic & 0x80) && v.artic !== 0) {
      v.count = (0x80 - v.artic) & 0xff;
      return { duty: 0, sweep: 0, bl: 0 };
    }
    for (let guard = 0; guard < 4096; guard++) {
      const b = this.u8(v.ptr++);
      if (b < 0x41) { v.len = b; continue; }
      if (b < 0x80) {
        switch (b - 0x41) {
          case 0: v.count = (v.len + v.artic) & 0x7f; return { duty: 0, sweep: 0, bl: 0 };
          case 1: { let p = (v.pos + 1) & 0xff; if (p === v.end) p = v.loop; v.pos = p; v.ptr = this.u16(v.seq + p * 2); continue; }
          case 2: this.playing = false; this.port.postMessage({ type: 'ended' }); return null;
          case 3: v.trans = this.u8(v.ptr++); continue;
          case 4: this.gTrans = (this.u8(v.ptr++) + 0x80) & 0xff; continue;
          case 5: this.tempo = this.u8(v.ptr++); continue;
          case 6: v.dutyStart = this.u8(v.ptr); v.dutySweep = this.u8(v.ptr + 1); v.ptr += 2; continue;
          case 7: this.slide = (this.inc(this.u8(v.ptr++)) >>> 2) & 0xffffff; continue;
          case 8: { const x = (~this.inc(this.u8(v.ptr++))) & 0xffffff; this.slide = ((x << 8) >> 10) & 0xffffff; continue; }
          case 9: v.rcount = this.u8(v.ptr++); v.rptr = v.ptr; continue;
          case 10: v.rcount = (v.rcount - 1) & 0xff; if (v.rcount) v.ptr = v.rptr; continue;
          case 11: v.dutyStart = this.u8(v.ptr++); v.dutySweep = 0; continue;
          case 12: v.artic = this.u8(v.ptr++); continue;
          case 13: v.artic = 0; continue;
          case 14: v.rcount = 2; v.rptr = v.ptr; continue;
          default: continue;
        }
      }
      const idx = (b + v.trans + this.gTrans) & 0xff;
      v.count = (v.len + v.artic) & 0x7f;
      return { duty: v.dutyStart, sweep: v.dutySweep, bl: (idx * 3) & 0xff };
    }
    return { duty: 0, sweep: 0, bl: 0 };
  }
  tick() {
    const v3 = this.v[2];
    v3.inc = (v3.inc - this.slide) & 0xffffff;
    const sum = this.acc + this.tempo;
    this.acc = sum & 0xff;
    if (sum < 0x100) return;
    for (let k = 0; k < 3 && this.playing; k++) {
      const v = this.v[k];
      v.count = (v.count - 1) & 0xff;
      if (v.count === 0) {
        if (k === 2) this.slide = 0;
        const n = this.next(v, k);
        if (!n) return;
        v.duty = n.duty; v.sweep = n.sweep; v.inc = this.inc(n.bl);
      } else {
        v.duty = (v.duty + v.sweep) & 0xff;
      }
    }
  }
  process(_, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.playing || !this.mz) { out.fill(0); return true; }
    const v = this.v;
    for (let i = 0; i < out.length; i++) {
      this.seqClock += this.seqStep;
      while (this.seqClock >= 1 && this.playing) { this.seqClock -= 1; this.tick(); }
      this.loopClock += this.loopStep;
      let n = 0, s = 0;
      while (this.loopClock >= 1) {
        this.loopClock -= 1;
        for (let k = 0; k < 3; k++) {
          v[k].phase = (v[k].phase + v[k].inc) & 0xffffff;
          if (((v[k].phase >> 16) & 0xff) < v[k].duty) s++;
        }
        n += 3;
      }
      out[i] = this.playing && n ? (s / n - 0.5) * 0.25 : 0;
    }
    return true;
  }
}
registerProcessor('mz-music', MzMusic);
`;

/**
 * MZ.DAT:0x00D6-0x012B: bp = synthesis loops in one 65536-count timer period,
 * bx = 0x1000000 / bp; each semitone step times bx, shifted down 8 bits, is
 * the 24-bit phase increment for the top octave, halved for each of the six
 * octaves below it (0x24 bytes lower each).
 */
export function pitchTable(mz, loopRate = LOOP_RATE) {
  const out = new Uint8Array(mz);
  const bp = Math.round((loopRate * 65536) / 1193182) & 0xffff;
  const bx = Math.floor(0x1000000 / bp) & 0xffff;
  let di = 0x598;
  for (let s = 0; s < 12; s++) {
    const step = mz[0x48a + s * 2] | (mz[0x48b + s * 2] << 8);
    let v = Math.floor((step * bx) / 256);          // dx:ah
    for (let o = 0; o < 7; o++) {
      out[di] = v & 0xff; out[di + 1] = (v >> 8) & 0xff; out[di + 2] = (v >> 16) & 0xff;
      v >>>= 1;
      di -= 0x24;
    }
    di += 0xff;
  }
  return out;
}

export class Music {
  constructor(mzBytes) {
    this.mz = pitchTable(mzBytes);
    this.node = null;
    this.ready = null;
    this.playing = false;
    this.loopRate = LOOP_RATE;
  }

  async init(ctx) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!ctx?.audioWorklet) return;
      const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(ctx, 'mz-music');
      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume ?? 0.5;
      this.node.connect(this.gain).connect(ctx.destination);
      this.node.port.postMessage({ type: 'load', mz: this.mz });
      this.node.port.onmessage = (e) => { if (e.data.type === 'ended') this.playing = false; };
    })();
    return this.ready;
  }

  play(tune) {
    this.playing = true;
    this.node?.port.postMessage({ type: 'play', tune, loopRate: this.loopRate, seqHz: SEQ_HZ });
    if (!this.node) this.playing = false;
  }

  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }

  stop() {
    this.playing = false;
    this.node?.port.postMessage({ type: 'stop' });
  }
}
