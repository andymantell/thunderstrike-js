import { Executable } from './exe.js';
import { Tables, Rng } from '../core/tables.js';
import { loadModels } from './models.js';
import { loadRounds } from './world.js';
import { decodeImage, decodeAnimation } from './igr.js';
import { basePalette } from './palette.js';

/**
 * Everything the port needs, decoded from the player's own copy of the game.
 * Only the VGA assets are used (the VGA version is the definitive one).
 */
export function loadGameData(files) {
  const exe = new Executable(files.get('TS.EXE'));
  const data = {
    files,
    exe,
    tables: new Tables(exe, files.get('BIN/N_SIN.BIN')),
    rng: new Rng(),
    models: loadModels(exe),
    rounds: loadRounds(files.get('BIN/L.DAT')),
    maps: [1, 2, 3, 4, 5].map((n) => files.get(`BIN/MAP${n}.M`)),
    skies: [1, 2, 3, 4, 5].map((n) => files.get(`SKY${n}.DAT`)),
    mz: files.get('MZ.DAT'),
    palette: basePalette(exe),
    images: {},
    anims: {},
  };
  for (const name of ['TPV', 'P_VGA', 'PILOTV', 'MANV', 'F1V', 'EXPLODEV', 'SHTDWNV', 'AWARDV',
    'TR0V', 'TR1V', 'TR2V', 'TR3V', 'TR4V', 'MENUABOV', 'MENUCRAV', 'MENUDOSV', 'MENUKEYV',
    'MENUMENV', 'MENUMISV', 'MENUMOUV', 'MENUOPTV', 'MENUPLAV']) {
    data.images[name] = decodeImage(files.get(`GR/${name}.IGR`));
  }
  for (const name of ['ANIM1V', 'ANIM2V']) data.anims[name] = decodeAnimation(files.get(`GR/${name}.IGR`));
  return data;
}
