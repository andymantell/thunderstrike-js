import { unzipSync } from 'fflate';

/**
 * A case-insensitive view over the original game files, keyed by their DOS
 * path relative to the game directory (e.g. "GR/TPV.IGR", "TS.EXE").
 * Accepts either a .zip of the game or a list of loose files.
 */
export class GameFiles {
  constructor(map) { this.files = map; }

  static fromZip(bytes) {
    const entries = unzipSync(bytes);
    return GameFiles.fromEntries(Object.entries(entries));
  }

  /** entries: [path, Uint8Array][] with arbitrary leading directories. */
  static fromEntries(entries) {
    const all = entries.map(([p, d]) => [p.replace(/\\/g, '/').toUpperCase(), d]);
    const exe = all.find(([p]) => p.endsWith('TS.EXE'));
    if (!exe) throw new Error('TS.EXE was not found. Please provide the original Thunderstrike game files.');
    const root = exe[0].slice(0, -'TS.EXE'.length);
    const map = new Map();
    for (const [p, d] of all) if (p.startsWith(root) && d.length) map.set(p.slice(root.length), d);
    return new GameFiles(map);
  }

  has(path) { return this.files.has(path.toUpperCase().replace(/\\/g, '/')); }
  get(path) {
    const d = this.files.get(path.toUpperCase().replace(/\\/g, '/'));
    if (!d) throw new Error(`Missing game file: ${path}`);
    return d;
  }
}
