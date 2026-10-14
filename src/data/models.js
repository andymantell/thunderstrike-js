/**
 * 3D models, stored in TS.EXE's data segment.
 *
 * An object's "model" word (object array 0x4B9) indexes a pointer table at
 * DS:0x8F70. Each model is:
 *   s16 positionCount   vertices that receive the object's translation
 *   u16 vertexCount     positions followed by one normal per face
 *   vertexCount * (s8 x, s8 y, s8 z)
 *   u16 faceCount
 *   per face: u16 normalVertex*2, u8 vertexCount, u8 colour, vertexCount * u16 vertex*2
 * Colour is a palette ramp base (high nibble); the low nibble is replaced by
 * a lighting shade at draw time.
 */
export const MODEL_TABLE = 0x8f70;
export const MODEL_COUNT = 0x3c / 2;

export function loadModels(exe) {
  const ds = exe.ds;
  const models = new Map();
  for (let id = 0; id < MODEL_COUNT * 2; id += 2) {
    const p = ds.u16(MODEL_TABLE + id);
    const positionCount = ds.s16(p);
    const vertexCount = ds.u16(p + 2);
    const verts = new Int8Array(vertexCount * 3);
    let q = p + 4;
    for (let i = 0; i < vertexCount * 3; i++) verts[i] = ds.s8(q + i);
    q += vertexCount * 3;
    const faceCount = ds.u16(q); q += 2;
    const faces = [];
    for (let f = 0; f < faceCount; f++) {
      const normal = ds.u16(q) >> 1;
      const count = ds.u8(q + 2);
      const colour = ds.u8(q + 3);
      q += 4;
      const idx = [];
      for (let i = 0; i < count; i++) idx.push(ds.u16(q + i * 2) >> 1);
      q += count * 2;
      faces.push({ normal, colour, idx });
    }
    models.set(id, { id, positionCount, vertexCount, verts, faces });
  }
  return models;
}
