/**
 * Arena maps (BIN/MAPn.M) and round layouts (BIN/L.DAT).
 *
 * A map is two 64x64 byte layers kept in one 8 KiB segment:
 *   0x0000 layer A: high nibble = terrain height (0..0xF0), low nibble flags
 *   0x1000 layer B: surface colour (palette ramp base + shade); values
 *          <= 0x10 are bare ground, 0x70 marks pads, 0xF0 pyramids.
 * Cell index = row * 64 + column. World X maps to column X>>10 and
 * world Z to row (Z>>10) - 16, both wrapping modulo 64.
 *
 * L.DAT holds, for each of the 50 rounds, a list of pyramid cells (which the
 * player defends) followed by a list of enemy bunker cells:
 *   u16 n, n * u16 cell, u16 m, m * u16 cell
 */
export function loadMap(bytes) {
  const m = new Uint8Array(0x2000);
  m.set(bytes.subarray(0, 0x2000));
  return m;
}

export function loadRounds(bytes) {
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const rounds = [];
  let p = 0;
  while (p + 2 <= bytes.length && rounds.length < 50) {
    const pyramids = [];
    let n = u16(p); p += 2;
    for (let i = 0; i < n; i++, p += 2) pyramids.push(u16(p));
    const bunkers = [];
    n = u16(p); p += 2;
    for (let i = 0; i < n; i++, p += 2) bunkers.push(u16(p));
    rounds.push({ pyramids, bunkers });
  }
  return rounds;
}
