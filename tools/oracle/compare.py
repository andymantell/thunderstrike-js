"""Report the first frame where the port's state differs from the original's.

usage: python compare.py orig.json port.json
"""
import json, sys

def first_difference(a, b):
    for f, (x, y) in enumerate(zip(a, b)):
        diffs = []
        for k, v in x.items():
            w = y.get(k)
            if k == 'map':
                if v != w:
                    va, wa = bytes.fromhex(v), bytes.fromhex(w)
                    d = [i for i in range(len(va)) if va[i] != wa[i]]
                    diffs.append(f'map: {len(d)} bytes, first {[(hex(i), va[i], wa[i]) for i in d[:4]]}')
            elif isinstance(v, list):
                diffs += [f'{k}[{i}] original={p:#x} port={q:#x}' for i, (p, q) in enumerate(zip(v, w)) if p != q]
            elif v != w:
                diffs.append(f'{k} original={v} port={w}')
        if diffs:
            return f, diffs
    return None, []

if __name__ == '__main__':
    a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
    f, diffs = first_difference(a, b)
    if f is None:
        print(f'identical for {min(len(a), len(b))} frames (original {len(a)}, port {len(b)})')
        sys.exit(0)
    print(f'frame {f} differs:')
    print('\n'.join(diffs[:40]))
    sys.exit(1)
