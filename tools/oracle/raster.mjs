// A CPU stand-in for the port's GPU pass: paints the pixel runs over the sky and ground,
// for comparing the 3D view with the original's frames.
export function rasterise(prims, groundColour) {
  const buf = new Uint8Array(256 * 128);
  for (let r = 0; r < 128; r++) buf.fill(r < 64 ? 0x80 + (r >> 1) : groundColour, r * 256, r * 256 + 256);
  for (const pr of prims) {
    for (const [row, x0, x1] of pr.runs) if (row >= 0 && row < 128) buf.fill(pr.colour, row * 256 + x0, row * 256 + x1 + 1);
  }
  return buf;
}
