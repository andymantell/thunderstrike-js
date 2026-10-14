import { GameFiles } from './data/archive.js';
import { loadGameData } from './data/loader.js';
import { saveArchive, loadArchive, forgetArchive } from './ui/storage.js';
import { App } from './app.js';
import { unzipSync } from 'fflate';

const loader = document.getElementById('loader');
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const errorBox = document.getElementById('error');

async function start(entries, remember) {
  const files = GameFiles.fromEntries(entries);
  const data = loadGameData(files);
  if (remember) await saveArchive(entries);
  loader.hidden = true;
  const app = new App(document.getElementById('screen'), data);
  window.thunderstrike = app;   // handy for debugging from the console
  app.run();
}

function showLoader(message = '') {
  loader.hidden = false;
  errorBox.textContent = message;
}

async function fromZip(buffer) {
  const entries = Object.entries(unzipSync(new Uint8Array(buffer)));
  // some archives (e.g. abandonware bundles) wrap the game in a nested zip
  const nested = entries.filter(([p]) => /\.zip$/i.test(p));
  if (!entries.some(([p]) => /ts\.exe$/i.test(p)) && nested.length) {
    return entries.concat(...nested.map(([, d]) => Object.entries(unzipSync(d))));
  }
  return entries;
}

async function readDirectory(entry, prefix = '') {
  const out = [];
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push([prefix + entry.name, new Uint8Array(await file.arrayBuffer())]);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) out.push(...await readDirectory(e, prefix + entry.name + '/'));
    }
  }
  return out;
}

async function handle(promise) {
  try { await start(await promise, true); }
  catch (e) { console.error(e); showLoader(String(e.message || e)); }
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (f) handle(f.arrayBuffer().then(fromZip));
});
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
  const entry = item?.webkitGetAsEntry?.();
  if (entry?.isDirectory) handle(readDirectory(entry));
  else if (item) handle(item.getAsFile().arrayBuffer().then(fromZip));
});

const DEV_FILES = ['TS.EXE', 'MZ.DAT', 'BIN/N_SIN.BIN', 'BIN/L.DAT', ...[1, 2, 3, 4, 5].flatMap((n) => [`BIN/MAP${n}.M`, `SKY${n}.DAT`]),
  ...['TPV', 'P_VGA', 'PILOTV', 'MANV', 'F1V', 'EXPLODEV', 'SHTDWNV', 'AWARDV', 'TR0V', 'TR1V', 'TR2V', 'TR3V', 'TR4V',
    'MENUABOV', 'MENUCRAV', 'MENUDOSV', 'MENUKEYV', 'MENUMENV', 'MENUMISV', 'MENUMOUV', 'MENUOPTV', 'MENUPLAV',
    'ANIM1V', 'ANIM2V'].map((n) => `GR/${n}.IGR`)];

/** Development only: read the original files from ./game (git-ignored). */
async function devFiles() {
  return Promise.all(DEV_FILES.map(async (p) => [p, new Uint8Array(await (await fetch(`game/${p}`)).arrayBuffer())]));
}

(async () => {
  if (import.meta.env?.DEV && location.search.includes('devdata')) { await start(await devFiles(), false); return; }
  const saved = await loadArchive();
  if (saved) {
    try { await start(saved, false); return; }
    catch (e) { console.error(e); await forgetArchive(); }
  }
  showLoader();
})();
