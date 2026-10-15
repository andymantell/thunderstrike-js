# Oracle: the original game as a reference

A development tool that checks the port against the original program. It runs your copy of `TS.EXE` in the
[Unicorn](https://www.unicorn-engine.org/) CPU emulator, feeds the original and the port the same key presses,
and compares their state after every frame: the object table, the random number generator, the terrain map,
shield, fuel, craft ratings and camera.

The emulator is only used here, to test. The port itself is plain JavaScript and does not emulate anything.

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/oracle/requirements.txt
```

The game files are found in `./game` or `$THUNDERSTRIKE_DIR`, as for the tests.

## Use

```sh
PYTHON=.venv/bin/python tools/oracle/compare.sh FRAMES CRAFT [--cheat=N] [--full] [--clear=N]
```

- `FRAMES`: arena frames to run (10 per second of play), `CRAFT`: 0-4.
- `--cheat=N`: type the developers' round-skip sequence every `N` frames to reach later rounds and arenas.
- `--full`: also type the full-upgrade sequence the first time.
- `--mouse`: control with the mouse (int 33h) instead of the keyboard, the game started with `VM`.
- `--pictures=N`: every `N` frames also compare the cockpit panel (VGA memory) and the HUD drawn over the 3D
  view, pixel for pixel. The 3D view itself is drawn by the GPU in the port and is not compared.
- `--clear=N`: every `N` frames, zero the bunker and enemy counts on both sides so the round ends, which runs
  the round results (and the craft rating changes they make).

It prints the first frame that differs and the fields that differ, or how many frames were identical. The
recordings are left in `tools/oracle/out/`.

## How it works

`ts.py` loads `TS.EXE` at segment 0x1000 with a small DOS (memory allocation, file reads from the game folder,
interrupt vectors), runs the start-up code with `VK` on the command line (VGA, keyboard), and then calls the game
start routines directly (`sub_2BAB`, `[0x9FFC]`, `sub_297F`), skipping the title and menus. The round intro
screens (`sub_ABEF`) are patched out, as `port.mjs` does not run them either. Each frame sets the keyboard
handler's tables and runs the main loop from `CS:22C1` to the frame wait at `CS:233B`. Any poll of the timer
counters advances them, so the timed waits of the results screens finish.

`port.mjs` runs the port's `Arena` through `Flow` with stub audio and video, the same way `Flow.play` does.
