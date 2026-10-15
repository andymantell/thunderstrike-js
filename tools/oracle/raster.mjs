// A CPU stand-in for the port's GPU pass, for comparing the 3D view with the original's frames:
// the same projection (sx = 128 + 100X/(Z+400), sy = 64 - 100Y/(Z+400)), painter's order and
// pixel-centre coverage, near plane at Z+400 = 10.
const NEAR = 10;

function clipNear(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const da = a[2] + 400 - NEAR, db = b[2] + 400 - NEAR;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

function fillPolygon(buf, pts, colour) {
  const p = pts.map(([x, y, z]) => [128 + (100 * x) / (z + 400), 64 - (100 * y) / (z + 400)]);
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of p) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let row = Math.max(0, Math.ceil(y0 - 0.5)); row <= Math.min(127, Math.floor(y1 - 0.5)); row++) {
    const cy = row + 0.5, xs = [];
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(255, Math.floor(xs[k + 1] - 0.5)); x++) buf[row * 256 + x] = colour;
    }
  }
}

export function rasterise(prims, groundColour) {
  const buf = new Uint8Array(256 * 128);
  for (let r = 0; r < 128; r++) buf.fill(r < 64 ? 0x80 + (r >> 1) : groundColour, r * 256, r * 256 + 256);
  for (const pr of prims) {
    if (pr.kind === 'poly') {
      const pts = clipNear(pr.pts);
      if (pts.length >= 3) fillPolygon(buf, pts, pr.colour);
    } else if (pr.kind === 'spans') {
      pr.rows.forEach(([x0, x1], i) => {
        const y = pr.top + i;
        if (y < 128) buf.fill(pr.colour, y * 256 + x0, y * 256 + x1 + 1);
      });
    }
  }
  return buf;
}
