/**
 * Integer helpers reproducing 8086 arithmetic. The original keeps almost all
 * state in 16-bit words and bytes, and relies on wrap-around (the arena is a
 * torus because world coordinates are unsigned 16-bit), so the simulation
 * works on plain JS numbers normalised through these helpers.
 */
export const u8 = (v) => v & 0xff;
export const s8 = (v) => (v << 24) >> 24;
export const u16 = (v) => v & 0xffff;
export const s16 = (v) => (v << 16) >> 16;

/** High word of the signed 16x16 product (IMUL r16 -> DX). */
export const imulHi = (a, b) => s16(Math.floor((s16(a) * s16(b)) / 65536));
/** Signed 16x16 product as a 32-bit value (DX:AX). */
export const imul32 = (a, b) => s16(a) * s16(b);
/** High word of the unsigned 16x16 product (MUL r16 -> DX). */
export const mulHi = (a, b) => Math.floor((u16(a) * u16(b)) / 65536) & 0xffff;
/** High byte of the signed 8x8 product (IMUL r8 -> AH). */
export const imul8Hi = (a, b) => s8(Math.floor((s8(a) * s8(b)) / 256));
/** x86 IDIV truncates towards zero. */
export const idiv = (a, b) => Math.trunc(a / b);
/** Arithmetic shift on a signed 16-bit value. */
export const sar = (v, n) => s16(v) >> n;
/** (DX:AX << 2) >> 16 : the "shl ah/rcl dx" twice idiom used after IMUL by a 16384-scaled sine. */
export const fixMul14 = (a, sinv) => s16(Math.floor((s16(a) * s16(sinv)) / 16384));
