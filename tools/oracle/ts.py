"""The original TS.EXE run in the Unicorn CPU emulator, as a reference.

A development tool for checking the JavaScript port, not part of it: it boots
the player's own TS.EXE on a minimal DOS (files, memory, vectors), and the
caller steps the game's own main loop and reads its data segment.
"""
import os, struct, sys
from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_INTR, UC_HOOK_INSN, UC_HOOK_CODE
from unicorn.x86_const import *

GAME = os.environ.get('THUNDERSTRIKE_DIR') or os.path.join(os.path.dirname(__file__), '..', '..', 'game')
PSP = 0x0ff0
LOAD = 0x1000


def lin(seg, off):
    return (seg << 4) + off


class TS:
    def __init__(self, cmd=b' VK'):
        exe = open(os.path.join(GAME, 'TS.EXE'), 'rb').read()
        (sig, cblp, cp, crlc, cparhdr, minalloc, maxalloc, ss, sp, csum, ip, cs, lfarlc) = struct.unpack('<13H', exe[:26])
        size = cp * 512 - (512 - cblp if cblp else 0) - cparhdr * 16
        img = exe[cparhdr * 16: cparhdr * 16 + size]
        self.uc = uc = Uc(UC_ARCH_X86, UC_MODE_16)
        uc.mem_map(0, 0x110000)
        uc.mem_write(lin(LOAD, 0), img)
        for i in range(crlc):
            off, seg = struct.unpack('<HH', exe[lfarlc + i * 4: lfarlc + i * 4 + 4])
            a = lin(LOAD + seg, off)
            v = struct.unpack('<H', uc.mem_read(a, 2))[0]
            uc.mem_write(a, struct.pack('<H', (v + LOAD) & 0xffff))
        # PSP: command tail
        uc.mem_write(lin(PSP, 0x80), bytes([len(cmd)]) + cmd + b'\r')
        uc.mem_write(lin(PSP, 0), b'\xcd\x20')
        uc.mem_write(0x463, struct.pack('<H', 0x3d4))   # BIOS: CRTC base port
        self.heap = LOAD + (size + 15) // 16 + minalloc + 0x100
        self.cs = LOAD + 0x485
        self.ds_seg = LOAD + 0x10a4
        uc.reg_write(UC_X86_REG_CS, LOAD + cs)
        uc.reg_write(UC_X86_REG_IP, ip)
        uc.reg_write(UC_X86_REG_SS, LOAD + ss)
        uc.reg_write(UC_X86_REG_SP, sp)
        uc.reg_write(UC_X86_REG_DS, PSP)
        uc.reg_write(UC_X86_REG_ES, PSP)
        self.files = {}
        self.next_handle = 5
        self.vectors = {}
        uc.hook_add(UC_HOOK_INTR, self.on_int)
        uc.hook_add(UC_HOOK_INSN, self.on_in, None, 1, 0, UC_X86_INS_IN)
        uc.hook_add(UC_HOOK_INSN, self.on_out, None, 1, 0, UC_X86_INS_OUT)
        self.log = []

    # ------------------------------------------------------------ helpers
    def r(self, reg):
        return self.uc.reg_read(reg)

    def w(self, reg, v):
        self.uc.reg_write(reg, v & 0xffff)

    def cf(self, on):
        f = self.r(UC_X86_REG_EFLAGS)
        self.uc.reg_write(UC_X86_REG_EFLAGS, (f | 1) if on else (f & ~1))

    def ds8(self, off):
        return self.uc.mem_read(lin(self.ds_seg, off), 1)[0]

    def ds16(self, off):
        return struct.unpack('<H', self.uc.mem_read(lin(self.ds_seg, off), 2))[0]

    def wds8(self, off, v):
        self.uc.mem_write(lin(self.ds_seg, off), bytes([v & 0xff]))

    def wds16(self, off, v):
        self.uc.mem_write(lin(self.ds_seg, off), struct.pack('<H', v & 0xffff))

    def cs16(self, off):
        return struct.unpack('<H', self.uc.mem_read(lin(self.cs, off), 2))[0]

    def wcs16(self, off, v):
        self.uc.mem_write(lin(self.cs, off), struct.pack('<H', v & 0xffff))

    def wcs8(self, off, v):
        self.uc.mem_write(lin(self.cs, off), bytes([v & 0xff]))

    def asciiz(self, seg, off):
        b = bytearray()
        while True:
            c = self.uc.mem_read(lin(seg, off + len(b)), 1)[0]
            if c == 0:
                return bytes(b)
            b.append(c)

    def find(self, name):
        parts = name.decode('latin1').replace('\\', '/').split('/')
        d = GAME
        for p in parts:
            if not p:
                continue
            m = [x for x in os.listdir(d) if x.lower() == p.lower()]
            if not m:
                return None
            d = os.path.join(d, m[0])
        return d

    # ------------------------------------------------------------ ports
    def on_in(self, uc, port, size, _):
        if port == 0x3da:          # retrace: toggle so waits finish
            self.retrace = getattr(self, 'retrace', 0) ^ 9
            return self.retrace
        return 0

    def on_out(self, uc, port, size, value, _):
        pass

    # ------------------------------------------------------------ interrupts
    def on_int(self, uc, intno, _):
        ah = self.r(UC_X86_REG_AH)
        al = self.r(UC_X86_REG_AL)
        if intno == 0x21:
            self.dos(ah, al)
        elif intno == 0x10:
            if ah == 0x0f:
                self.w(UC_X86_REG_AX, 0x5003)
                self.w(UC_X86_REG_BX, 0)
            elif ah == 0x1a:
                self.w(UC_X86_REG_AX, 0x1a)
                self.w(UC_X86_REG_BX, 8)
        elif intno == 0x33:
            if self.r(UC_X86_REG_AX) == 0:
                self.w(UC_X86_REG_AX, 0)
        elif intno == 0x80:
            if ah in (0, 0x84):
                self.w(UC_X86_REG_AX, 0)
        elif intno in (0x11, 0x12, 0x16, 0x1a, 0x15):
            self.w(UC_X86_REG_AX, 0)
        else:
            self.log.append(('int', hex(intno), hex(ah)))

    def dos(self, ah, al):
        uc = self.uc
        ds = self.r(UC_X86_REG_DS)
        dx = self.r(UC_X86_REG_DX)
        bx = self.r(UC_X86_REG_BX)
        cx = self.r(UC_X86_REG_CX)
        if ah == 0x25:
            self.vectors[al] = (ds, dx)
        elif ah == 0x35:
            s, o = self.vectors.get(al, (0, 0))
            self.w(UC_X86_REG_ES, s)
            self.w(UC_X86_REG_BX, o)
        elif ah == 0x30:
            self.w(UC_X86_REG_AX, 0x0005)
        elif ah == 0x48:
            seg = self.heap
            self.heap += bx
            if self.heap > 0xa000:
                raise RuntimeError('out of memory')
            self.w(UC_X86_REG_AX, seg)
            self.cf(False)
        elif ah in (0x49, 0x4a):
            self.cf(False)
        elif ah == 0x3d:
            name = self.asciiz(ds, dx)
            p = self.find(name)
            self.log.append(('open', name, p))
            if not p:
                self.w(UC_X86_REG_AX, 2)
                self.cf(True)
                return
            h = self.next_handle
            self.next_handle += 1
            self.files[h] = [open(p, 'rb').read(), 0]
            self.w(UC_X86_REG_AX, h)
            self.cf(False)
        elif ah == 0x3f:
            f = self.files[bx]
            data = f[0][f[1]: f[1] + cx]
            f[1] += len(data)
            uc.mem_write(lin(ds, dx), data)
            self.w(UC_X86_REG_AX, len(data))
            self.cf(False)
        elif ah == 0x3e:
            self.files.pop(bx, None)
            self.cf(False)
        elif ah == 0x42:
            f = self.files[bx]
            off = (cx << 16) | dx
            f[1] = off if al == 0 else f[1] + off if al == 1 else len(f[0]) + off
            self.w(UC_X86_REG_AX, f[1] & 0xffff)
            self.w(UC_X86_REG_DX, f[1] >> 16)
            self.cf(False)
        elif ah in (0x09, 0x02, 0x0b, 0x0e, 0x19, 0x1a, 0x2c, 0x2a):
            self.w(UC_X86_REG_AX, 0)
        elif ah == 0x4c:
            raise RuntimeError('exit')
        else:
            self.log.append(('dos', hex(ah)))
        self.cf(False) if ah not in (0x3d, 0x3f, 0x3e, 0x42, 0x48) else None

    # ------------------------------------------------------------ running
    def run_to(self, cs_off, count=50_000_000):
        target = lin(self.cs, cs_off)
        start = lin(self.r(UC_X86_REG_CS), self.r(UC_X86_REG_IP))
        self.uc.emu_start(start, target, count=count)
        here = lin(self.r(UC_X86_REG_CS), self.r(UC_X86_REG_IP))
        if here != target:
            raise RuntimeError(f'stopped at {self.r(UC_X86_REG_CS):04x}:{self.r(UC_X86_REG_IP):04x}')

    def call(self, cs_off, count=50_000_000):
        """Call a near routine in the game's code segment and return."""
        sp = self.r(UC_X86_REG_SP) - 2
        ret = 0xfff0   # a HLT-free return address: we stop when IP reaches it
        self.uc.mem_write(lin(self.r(UC_X86_REG_SS), sp), struct.pack('<H', ret))
        self.w(UC_X86_REG_SP, sp)
        self.w(UC_X86_REG_CS, self.cs)
        self.w(UC_X86_REG_IP, cs_off)
        self.uc.emu_start(lin(self.cs, cs_off), lin(self.cs, ret), count=count)
        if self.r(UC_X86_REG_IP) != ret:
            raise RuntimeError(f'call {cs_off:04x} stopped at {self.r(UC_X86_REG_CS):04x}:{self.r(UC_X86_REG_IP):04x}')


    # ------------------------------------------------------------ game
    TIMER_POLLS = (0x9dca, 0x9dd3, 0x77d4, 0x2c68, 0x2f51, 0x227b)

    def start_game(self, slot):
        """Boot, then start a game the way CS:22B4 does, without the front end."""
        self.run_to(0x2249)
        self.wcs8(0xabef, 0xc3)          # round intro screens: return at once
        self.wds16(0x4286, slot * 2)     # chosen craft
        self.wcs16(0x82f1, self.ds16(0x674e))   # picture buffer, normally set by the title screen (sub_87F3)
        # every poll of the timer counters lets one 50 Hz tick pass, so the
        # front end's timed waits (round results) run to their end
        for a in self.TIMER_POLLS:
            self.uc.hook_add(UC_HOOK_CODE, self._tick, None, lin(self.cs, a), lin(self.cs, a))
        self.call(0x2bab)
        self.call(self.ds16(0x9ffc))
        self.call(0x297f)
        self.held = set()

    def _tick(self, uc, addr, size, _):
        for o in (0x81e6, 0x81e8, 0x81ea):
            self.wcs16(o, self.cs16(o) + 1)

    def keys(self, held):
        """Set the INT 9 handler's tables (CS:7930) for the keys held this frame."""
        for sc in range(1, 128):
            if sc in held and sc not in self.held:
                self.wds8(0x9e00 + sc, 1)
                self.wds16(0x9e80, 0x9d80 + sc)
            self.wds8(0x9d80 + sc, 0 if sc in held else 0x80)
        self.held = set(held)

    def frame(self):
        """One pass of the main loop, CS:22C1 up to the frame wait at CS:233B."""
        self.w(UC_X86_REG_CS, self.cs)
        self.w(UC_X86_REG_IP, 0x22c1)
        self.run_to(0x233b, count=2_000_000_000)
