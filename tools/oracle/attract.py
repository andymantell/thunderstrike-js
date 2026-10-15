"""Record the original attract demo (sub_9230): the work buffer and [0x6830] after each frame.

usage: python attract.py frames out.json
"""
import json, sys
from ts import TS, lin
from unicorn import UC_HOOK_CODE

def main(frames, out_file):
    t = TS()
    t.run_to(0x2249)
    t.wcs16(0x82f1, t.ds16(0x674e))
    out = []
    def frame(uc, addr, size, _):
        out.append({'view': bytes(t.uc.mem_read(lin(t.ds16(0x674e), 0), 256 * 128)).hex(), 'quarters': t.ds8(0x6830),
                    'x': t.ds16(0x2c5), 'z': t.ds16(0x38d), 'yaw': t.ds8(0x4f), 'in': t.ds16(0x9fea), 'timer': t.ds16(0xa7a4), 'target': t.ds16(0xa7a6), 'rng': t.uc.mem_read(lin(t.cs, 0x8148), 1)[0]})
        if len(out) >= frames:
            uc.emu_stop()
    t.uc.hook_add(UC_HOOK_CODE, frame, None, lin(t.cs, 0x92a6), lin(t.cs, 0x92a6))   # after the blit and sub_934D
    try:
        t.call(0x9230, count=2_000_000_000)
    except RuntimeError:
        pass
    json.dump(out, open(out_file, 'w'))

main(int(sys.argv[1]), sys.argv[2])
