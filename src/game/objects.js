/**
 * The object table. The original keeps 50 object slots as a structure of
 * arrays in DS (each array 100 bytes apart); slot 0 is always the player.
 * Field names below are ours; the comment gives the original array base.
 */
export const MAX_OBJECTS = 50;

export const T = {
  EMPTY: 0x00,
  PLAYER: 0x02,
  EXPLOSION: 0x08,      // animated debris cloud, AI 0x3598
  SMALL_EXPLOSION: 0x09,// AI 0x35B6
  SHOT: 0x10,           // player bullet
  DEFENDER: 0x11,       // defence pod orbiting the player
  ENEMY_SHOT: 0x20,
  SHRAPNEL: 0x21,
  FALLING: 0x30,
  FIGHTER: 0x31,
  GLIDER: 0x32,
  MINER: 0x33,
  SABOTEUR: 0x34,
  THIEF: 0x35,          // saboteur carrying away a pyramid
  LUNGER: 0x36,
  POD_FUEL: 0x40,
  POD_SHIELD: 0x41,
  POD_DEFENCE: 0x42,
  POD_TWIN: 0x43,
  POD_POWER: 0x44,
  POD_TURBO: 0x45,
};

export class Objects {
  constructor() {
    const n = MAX_OBJECTS;
    const w = () => new Uint16Array(n);
    this.x = w();       // 0x2C5 world X
    this.y = w();       // 0x329 altitude
    this.z = w();       // 0x38D world Z
    this.radius = w();  // 0x3F1 depth bias used when culling (always 0 in practice)
    this.model = w();   // 0x4B9 model id; low byte >= 0x80 marks a particle effect
    this.vxv = w();     // 0x51D view-space X (camera relative, /4)
    this.vyv = w();     // 0x581 view-space Y
    this.vzv = w();     // 0x5E5 view-space Z (/4)
    this.pitch = w();   // 0x649
    this.yaw = w();     // 0x6AD
    this.roll = w();    // 0x711
    this.vx = w();      // 0x775
    this.vy = w();      // 0x7D9
    this.vz = w();      // 0x83D
    this.type = w();    // 0x8A1
    this.cell = w();    // 0x907 terrain window cell (for draw ordering)
    this.t1 = w();      // 0x96B timers / state (bytes 0x96B,0x96C)
    this.t2 = w();      // 0x9CF state (bytes 0x9CF,0x9D0)
    this.link = w();    // 0xA33 linked pyramid index / state
    this.damage = w();  // 0xA97 bullet damage (byte)
    this.hp = w();      // 0xAFA hit points (byte)
    this.flags = w();   // 0xB5E bit0: spawning, bit1: hit flash
  }

  clearAll() {
    for (const k of Object.keys(this)) this[k].fill(0);
  }

  clearSlot(s) {
    for (const k of Object.keys(this)) this[k][s] = 0;
  }
}

/** byte helpers for the word arrays that the code also touches bytewise */
export const lo = (w) => w & 0xff;
export const hi = (w) => (w >> 8) & 0xff;
export const setLo = (w, b) => (w & 0xff00) | (b & 0xff);
export const setHi = (w, b) => (w & 0x00ff) | ((b & 0xff) << 8);
