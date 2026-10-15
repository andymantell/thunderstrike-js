"""Compare the pictures recorded with --pictures=N.

The panel (VGA memory, 320x200) is compared pixel for pixel. The 3D window is
compared whole: the HUD layer, and the view rebuilt from the port's pixel
runs (raster.mjs paints them the way the GPU does).

usage: python pictures.py orig.json port.json
"""
import json, sys

def write_ppm(path, a, b):
    """original | port | differences, grey levels from the colour index"""
    rows = []
    for y in range(128):
        for x in range(256 * 3):
            i = y * 256 + x % 256
            v = a[i] if x < 256 else b[i] if x < 512 else (255 if a[i] != b[i] else 0)
            rows.append(bytes([v, (v * 7) & 255, (v * 13) & 255]))
    open(path, 'wb').write(b'P6 768 128 255\n' + b''.join(rows))

def main(a_file, b_file):
    a, b = json.load(open(a_file)), json.load(open(b_file))
    bad = 0
    for f, (x, y) in enumerate(zip(a, b)):
        if 'screen' not in x or 'screen' not in y:
            continue
        sa, sb = bytes.fromhex(x['screen']), bytes.fromhex(y['screen'])
        # outside the 3D window (32,16)-(288,144)
        panel = [(i % 320, i // 320) for i in range(64000)
                 if sa[i] != sb[i] and not (32 <= i % 320 < 288 and 16 <= i // 320 < 144)]
        va, vb = bytes.fromhex(x['view']), bytes.fromhex(y['view'])
        hud = [(i % 256, i // 256) for i in range(256 * 128) if vb[i] and va[i] != vb[i]]
        fr = bytes.fromhex(y['frame']) if 'frame' in y else None
        same = sum(1 for i in range(256 * 128) if fr[i] == va[i]) if fr else 0
        view = 32768 - same if fr else 0
        status = ('ok' if not panel and not hud and not view else 'DIFFERENT') + (f'  3D view {view} px differ' if fr else '')
        if fr and '--dump' in sys.argv:
            write_ppm(f'{a_file}.{f}.ppm', va, fr)
        if panel or hud or view:
            bad += 1
        print(f'frame {f}: panel {len(panel)} px differ {panel[:6]}, HUD {len(hud)} px differ {hud[:6]}  {status}')
    return bad

if __name__ == '__main__':
    sys.exit(1 if main(sys.argv[1], sys.argv[2]) else 0)
