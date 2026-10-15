"""Step the original game with a list of held keys per frame and record its state.

usage: python orig.py keys.json slot out.json [force_clear]
"""
import json, sys
from ts import TS, lin
from state import FIELDS

def snapshot(t):
    s = {k: [t.ds16(b + i * 2) for i in range(24)] for k, b in FIELDS}
    s['rng'] = t.uc.mem_read(lin(t.cs, 0x8148), 1)[0]          # sub_8134 seed
    s['shield'] = t.ds16(0x15fa)
    s['fuel'] = t.ds16(0x68)
    s['round'] = t.ds16(0xc8)
    s['roundOver'] = t.ds16(0x38)
    s['dying'] = t.ds16(0x15f8)
    s['craft'] = [t.ds16(0xb0), t.ds16(0xb2), t.ds16(0xb4)]
    s['camera'] = [t.ds16(0x6622), t.ds8(0x6620), t.ds16(0x662d)]
    s['map'] = bytes(t.uc.mem_read(lin(t.ds16(0xd4), 0), 0x2000)).hex()
    return s

def main(keys_file, slot, out_file, force_clear=0):
    frames = json.load(open(keys_file))
    mouse = frames and isinstance(frames[0], dict)
    t = TS(mouse=mouse)
    t.start_game(slot)
    out = []
    for f, held in enumerate(frames):
        if force_clear and f % force_clear == force_clear - 1:
            t.wds16(0x2320, 0)   # bunkers left
            t.wds16(0x4308, 0)   # enemies
        if mouse:
            t.keys(held['keys'])
            t.mouse_state(*held['mouse'])
        else:
            t.keys(held)
        try:
            t.frame()
        except Exception as e:   # game over: the original goes back to its title screen
            print(f'frame {f}: the original left the arena loop ({e})')
            break
        out.append(snapshot(t))
    json.dump(out, open(out_file, 'w'))

if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 0)
