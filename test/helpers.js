import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GameFiles } from '../src/data/archive.js';

/** Locate the user's game files for tests: THUNDERSTRIKE_DIR or ./game */
export function gameFiles() {
  const dir = process.env.THUNDERSTRIKE_DIR || join(process.cwd(), 'game');
  const entries = [];
  const walk = (d, rel) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, rel + n + '/');
      else entries.push([rel + n, new Uint8Array(readFileSync(p))]);
    }
  };
  try { walk(dir, ''); } catch { return null; }
  try { return GameFiles.fromEntries(entries); } catch { return null; }
}
