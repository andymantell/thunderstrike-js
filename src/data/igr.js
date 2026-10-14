/**
 * IGR image files (GR/*.IGR). VGA variants end in V.IGR.
 *
 * Still image layout:
 *   u16 firstColour, u16 colourCount, colourCount*3 bytes VGA DAC (0..63),
 *   u16 width, u16 height, u16 packedSize, packed pixels.
 * Animation layout (ANIM1V/ANIM2V):
 *   u16 width, u16 height, u16 x, u16 y, u16 frames,
 *   per frame: u16 packedSize, packed pixels.
 * Packing is a PackBits-style RLE: n<0x80 copies n+1 literal bytes,
 * n>=0x80 repeats the following byte 257-n times.
 */
export function unpackRle(src, start, end, out) {
  let p = start, o = 0;
  while (p < end && o < out.length) {
    const n = src[p++];
    if (n >= 0x80) {
      const v = src[p++];
      for (let i = 257 - n; i > 0 && o < out.length; i--) out[o++] = v;
    } else {
      for (let i = n + 1; i > 0 && o < out.length; i--) out[o++] = src[p++];
    }
  }
  return p;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);

export function decodeImage(bytes) {
  let p = 0;
  const firstColour = u16(bytes, p), colourCount = u16(bytes, p + 2); p += 4;
  const palette = bytes.slice(p, p + colourCount * 3); p += colourCount * 3;
  const width = u16(bytes, p), height = u16(bytes, p + 2), size = u16(bytes, p + 4); p += 6;
  const pixels = new Uint8Array(width * height);
  unpackRle(bytes, p, p + size, pixels);
  return { firstColour, colourCount, palette, width, height, pixels };
}

export function decodeAnimation(bytes) {
  const width = u16(bytes, 0), height = u16(bytes, 2), x = u16(bytes, 4), y = u16(bytes, 6), count = u16(bytes, 8);
  let p = 10;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const size = u16(bytes, p); p += 2;
    const px = new Uint8Array(width * height);
    unpackRle(bytes, p, p + size, px);
    p += size;
    frames.push(px);
  }
  return { width, height, x, y, frames };
}
