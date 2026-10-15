# Thunderstrike JS

A three.js reimplementation of **Thunderstrike** (Millennium, 1990, MS-DOS VGA version), rebuilt from a
disassembly of the original `TS.EXE` as readable JavaScript.

**This repository contains no game data.** The original graphics, 3D models, text, maps, music and sound
effects are still under copyright. You supply your own copy of the DOS release. The page reads the files in
your browser and keeps them on your device only.

## Playing

1. Open the site (GitHub Pages) or run it locally (see below).
2. Download the DOS version of the game, for example from
   [My Abandonware](https://www.myabandonware.com/game/thunderstrike-11d) (`Thunderstrike_DOS_EN.zip`), or use
   your own copy of the original release.
3. Drop the .zip (no need to unzip it), or the folder that contains `TS.EXE`, anywhere on the page. The game
   needs `TS.EXE`, `MZ.DAT`, `SKY1-5.DAT`, `BIN/*` and the `GR/*V.IGR` VGA pictures. It is remembered on that
   device, so this is needed only once.
4. Click the page once to enable sound.

Thunderstrike is still under copyright; whether you may download it where you live is for you to judge.

Default keys (redefinable from Options, as in the original):

| Key | Action |
| --- | --- |
| Z / X | turn left / right |
| L / , | climb / dive |
| P | thrust (tap twice quickly for a turbo burst, once you have turbo pods) |
| Space | fire |
| Esc / F1 / F2 / F3 | menu choices (Esc: DOS or abort, F1: options, F2: play, F3: craft) |
| F4 | round, arena and game statistics |
| F10 | pause (Q steps one frame while paused) |

Use the **Settings** button to switch to mouse control, pick the graphics mode or set the volume. All three
graphics modes play exactly the same game (the game itself always runs at its original 10 frames a second):

- **Original**: the original's own frames, pixel for pixel.
- **Original, smooth**: the original's pixel-exact renderer, drawing in-between frames at the screen's refresh
  rate (for example 120 fps). Moving things are blended between game frames, which shows the picture one game
  frame (0.1 s) late.
- **Enhanced 3D**: the same scene drawn by three.js as real 3D at screen resolution, smooth as above. The
  land reaches three times as far as the original's (48 cells instead of 16), fading into the distance.

The menus can be clicked with the mouse in either control mode.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit/simulation tests; needs the game files, see below
npm run build      # static site in dist/
```

During development, put (or symlink) your game folder at `./game` (it is git-ignored) and open
`http://localhost:5173/?devdata` to skip the file picker. Tests look for the files in `./game` or in
`$THUNDERSTRIKE_DIR`, and skip themselves when the files are not there.

Pushes to `main` build and deploy to GitHub Pages through `.github/workflows/pages.yml`. If
Pages has not been enabled for the repository, enable it under **Settings → Pages → Source: GitHub
Actions**.

## How it is put together

| Path | Original | Notes |
| --- | --- | --- |
| `src/data/` | file formats | IGR RLE pictures and animations, maps, round layouts, 3D models and tables read from TS.EXE's data segment |
| `src/core/` | 8086 arithmetic, trig | 16-bit wrap-around, the game's sine/arctangent tables, `N_SIN.BIN`, the 8-bit RNG |
| `src/game/arena.js` | main loop `CS:22C1` | player flight, weapons, collisions, waves, round end, camera |
| `src/game/ai.js` | dispatch `DS:0x4377` | fighter, glider, miner, saboteur, lunger, pods, defence pods, explosions |
| `src/game/terrain.js` | `sub_14E8`, `sub_201E`, `sub_20C2` | height interpolation, bunkers and pyramids built into the map |
| `src/render/scene.js` | `sub_1BFA`, `sub_3D32`, `sub_1D2B`, `sub_15A2`, `sub_4143` | the original view-space maths and painter's draw order |
| `src/render/pipeline.js` | `sub_43C5`, `sub_4770`, `sub_08EE`, `sub_6870`, `sub_6A64`, `sub_5E22` | the original's polygon pipeline: near clip, integer projection, screen clip and edge walkers, giving the exact pixel runs of every face |
| `src/render/smooth.js`, `src/render/modern.js` | | in-between frames for the smooth modes, and the floating-point scene for enhanced 3D |
| `src/render/renderer.js` | VGA output | three.js draws those runs in the original order into a 256x128 colour-index target; a final pass composes the 320x200 screen through the VGA palette |
| `src/render/hud.js` | `sub_0D6D`, `sub_0F4E`, `sub_62BE` | messages, scanner, arena map, gauges, counters |
| `src/flow.js` | front end `0x9D0B-0xBFFF` | title, attract mode, presenter, menus, craft selection, briefings, results, game over |
| `src/audio/` | `MZ.DAT` int 80h driver | PC-speaker effects and the three-voice PWM music player |

The simulation runs at the original 10 frames per second (one frame every five 50 Hz timer ticks), with the
same integer arithmetic, so behaviour matches the DOS game.

### Checking against the original

`tools/oracle` runs your `TS.EXE` in a CPU emulator next to the port, feeds both the same key presses and
compares their state every frame (objects, random numbers, terrain, shield, craft ratings, camera) and, on
sampled frames, every pixel of the cockpit and the 3D view. Scripted runs through every arena with each craft,
and through the end-of-round results, come out identical frame for frame. See [tools/oracle/README.md](tools/oracle/README.md). The emulator is only a test tool; the game itself
is the JavaScript in `src/`.

### Known differences

- The music driver calibrates itself against the CPU, so pitch and tempo match the original on any machine,
  but the grain of its pulse-width synthesis depends on how fast that loop ran. A period machine is assumed
  (`LOOP_RATE` in `src/audio/music.js`).
- Mouse speed is passed to the DOS mouse driver (int 33h function 1Ah), whose exact response curve is not
  known; the port scales pointer movement linearly. The pointer is locked to the page only while flying;
  in the menus, and until the game is clicked, the mouse position maps directly onto the cockpit window.
- The joystick calibration screens are not reproduced. Keyboard and mouse control are.
- Only the VGA version is ported. The EGA and CGA drivers in the executable are not.
