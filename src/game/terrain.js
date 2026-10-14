/**
 * Arena terrain: the two 64x64 map layers plus the installations that are
 * built into them each round (sub_1E69, sub_201E, sub_20C2).
 *
 * Bunkers ("generators", enemy launch sites) are 2x2 vertex plateaus raised
 * by 0x70 and surrounded by pad cells of type 0x70. Pyramids
 * ("installations" the player defends) are single vertices raised by 0x90
 * with four 0xF0 cells around them.
 */
import { u8, s8, u16, s16 } from '../core/int.js';
import { loadMap } from '../data/world.js';

export const A = 0x0000;   // layer A offset in the map segment (heights)
export const B = 0x1000;   // layer B offset (surface type / colour)

export class Terrain {
  constructor(data) {
    this.data = data;
    this.map = new Uint8Array(0x2000);
    this.bunkers = [];
    this.pyramids = [];
    this.bunkersLeft = 0;     // [0x2320]
    this.pyramidsLeft = 0;    // [0x3880]
    this.saboteurRandom = 0x40;
    this.pyramidCountForRandom = 0; // [0x3884]
    this.originRow = 0; this.originCol = 0;
  }

  /** sub_1ED9 + sub_1E69 */
  loadRound(round, stats) {
    const arena = Math.floor(round / 10);
    this.map.set(loadMap(this.data.maps[arena]));
    const layout = this.data.rounds[round];
    this.setupBunkers(layout.bunkers);
    this.setupPyramids(layout.pyramids, stats);
  }

  /** sub_201E */
  setupBunkers(cells) {
    const m = this.map;
    this.bunkers = [];
    this.bunkersLeft = cells.length;
    for (const c of cells) {
      const base = m[A + c] & 0xf0;
      const raised = u8(base + 0x70);
      for (const d of [0, -1, -0x40, -0x41]) m[A + ((c + d) & 0xfff)] = raised;
      const set = (cell, v) => { m[B + (cell & 0xfff)] = v; };
      let bx = c - 0x40;
      const spawnCell = bx & 0xfff;
      set(bx - 1, 0xc0); set(bx, 0x70); set(bx + 1, 0xc0);
      bx += 0x3f; const pad2 = bx & 0xfff; set(bx, 0x70); set(bx + 1, 0xc0);
      bx += 2; const pad3 = bx & 0xfff; set(bx, 0x70);
      bx += 0x3f; const pad4 = bx & 0xfff; set(bx - 1, 0xc0); set(bx, 0x70); set(bx + 1, 0xc0);
      this.bunkers.push({ cell: c, base, spawnCell, pads: [spawnCell, pad2, pad3, pad4], health: 5, cooldown: 0, sunk: false });
    }
  }

  /** sub_20C2 */
  setupPyramids(cells, stats) {
    const m = this.map;
    this.pyramids = [];
    this.pyramidsLeft = cells.length;
    this.pyramidCountForRandom = cells.length;
    stats?.pyramidsPlaced(cells.length);
    for (const c of cells) {
      const x = (c & 0x3f) << 10;
      const z = u16(((c & 0xfc0) + 0x400) << 4);
      const base = m[A + c] & 0xf0;
      m[A + c] = u8(base + 0x90);
      for (const d of [0, 1, 0x40, 0x41]) {
        const k = (c + d) & 0xfff;
        m[A + k] = (m[A + k] & 0xf0) | 9;
        m[B + k] = 0xf0;
      }
      this.pyramids.push({ cell: c, x, z, base, timer: 0x96 });
    }
  }

  /** bunker index owning a pad cell, or -1 (search at 0x3E9) */
  bunkerAtCell(cell) {
    for (let i = 0; i < this.bunkers.length; i++) if (this.bunkers[i].pads.includes(cell)) return i;
    return -1;
  }

  /** 0x0410: a shot lands on a bunker pad. */
  damageBunker(i, dmg, onDestroyed) {
    const b = this.bunkers[i];
    const hp = s8((b.health & 0xff) - dmg);
    b.health = (b.health & 0xff00) | (hp & 0xff);
    if (hp > 0) return;
    onDestroyed();
    b.health = 0;
    for (const p of [b.spawnCell, b.spawnCell + 0x3f, b.spawnCell + 0x41, b.spawnCell + 0x80]) this.map[B + (p & 0xfff)] = 0x10;
    this.bunkersLeft--;
  }

  /** sub_06AF: destroyed bunkers sink back into the ground. */
  sinkBunkers() {
    const m = this.map;
    for (const b of this.bunkers) {
      if (b.health === 0) {
        const di = b.spawnCell;
        const al = u8(m[A + di] - 4);
        for (const d of [0, -1, 0x40, 0x3f]) m[A + ((di + d) & 0xfff)] = al;
        if ((al & 0xf0) === b.base) b.health = 0xffff;
      }
      if (b.cooldown) b.cooldown--;
    }
  }

  /** sub_2188 */
  destroyPyramid(i, g) {
    const p = this.pyramids[i];
    g.sound.request(0x1201);
    p.timer = 0xffff;
    this.pyramidsLeft--;
    for (const d of [0, 1, 0x40, 0x41]) this.map[B + ((p.cell + d) & 0xfff)] = 0x10;
    g.stats.pyramidLost();
  }

  /** sub_21E1: destroyed pyramids collapse one step per frame. */
  rebuildPyramids() {
    const m = this.map;
    for (const p of this.pyramids) {
      if (p.timer !== 0xffff) continue;
      const al = u8((m[A + p.cell] & 0xf0) - 0x10);
      m[A + p.cell] = al;
      if (al === p.base) p.timer = 0xff00;
    }
  }

  /** sub_14E8: bilinear terrain height at a world position. */
  heightAt(x, z) {
    const m = this.map;
    const xf = (x >> 2) & 0xff, zf = (z >> 2) & 0xff;
    const col = (x >> 10) & 0x3f;
    const row = (((z >> 10) - 0x10 + 1) & 0x3f);
    const rowOff = row << 6;
    let di = col | rowOff;
    let si = ((col + 1) & 0x3f) | rowOff;
    const cornerCell = si;
    const lerp = (a, b, f) => u8(b + (((a - b) * f) >> 8));
    const top = lerp(m[A + si] & 0xf0, m[A + di] & 0xf0, xf);
    di = (di - 0x40) & 0xfff; si = (si - 0x40) & 0xfff;
    const bottom = lerp(m[A + si] & 0xf0, m[A + di] & 0xf0, xf);
    const height = lerp(top, bottom, zf);
    return { height, cornerA: m[A + cornerCell], cornerCell };
  }

  /** sub_156F: cell index used for surface-type lookups. */
  cellAt(x, z) {
    const col = (x >> 10) & 0x3f;
    const row = ((z >> 10) - 0xf) & 0x3f;
    return ((col + 1) & 0x3f) | (row << 6);
  }
  typeAt(x, z) { return this.map[B + this.cellAt(x, z)]; }

  windowCol() { return this.originCol; }
  windowRow() { return this.originRow; }
}
