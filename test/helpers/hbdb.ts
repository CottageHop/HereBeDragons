import {
  BUILDING_KIND_ROOF,
  BUILDING_KIND_WALL,
  BUILDING_STYLE_FLOATS,
  BUILDING_STYLE_FLOATS_V1
} from '../../src/splats/buildingMesh.js';

/** A minimal HBDB (SplatMap splatmap/splat/building_mesh.py): one roof and one wall triangle.
 *  Version 2 (default) carries the building's seed and 35-float styles; version 1 neither. */
export function makeHbdb(version: 1 | 2 = 2, seed = 0xC0FFEE): ArrayBuffer {
  const n = 6;
  const nb = 1;
  const ns = 1;
  const floats = version === 1 ? BUILDING_STYLE_FLOATS_V1 : BUILDING_STYLE_FLOATS;
  const record = version === 1 ? 8 : 12;
  const bytes = 28 + n * 32 + nb * record + ns * floats * 4;
  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf);
  'HBDB'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint16(4, version, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, nb, true);
  dv.setUint32(16, ns, true);
  dv.setFloat32(20, 611.5, true);
  dv.setFloat32(24, 1.32, true);
  let off = 28;
  const pos = [10, 10, 30, 20, 10, 30, 10, 20, 30, /* wall */ 10, 10, 0, 20, 10, 0, 20, 10, 30];
  pos.forEach((v, i) => dv.setFloat32(off + i * 4, v, true)); off += n * 12;
  const uv = [10 / 611.5, 10 / 611.5, 20 / 611.5, 10 / 611.5, 10 / 611.5, 20 / 611.5, 0, 0, 7.6, 0, 7.6, 22.7];
  uv.forEach((v, i) => dv.setFloat32(off + i * 4, v, true)); off += n * 8;
  const wall = [0, 0, 0, 0, 0, 0, 7.6, 22.7, 7.6, 22.7, 7.6, 22.7];
  wall.forEach((v, i) => dv.setFloat32(off + i * 4, v, true)); off += n * 8;
  for (let i = 0; i < n; i++) dv.setUint16(off + i * 2, 0, true); off += n * 2;
  for (let i = 0; i < n; i++) dv.setUint8(off + i, i < 3 ? BUILDING_KIND_ROOF : BUILDING_KIND_WALL); off += n;
  off += n; // flags
  dv.setUint8(off, 0); dv.setUint8(off + 1, 200); dv.setUint8(off + 2, 100); dv.setUint8(off + 3, 50);
  dv.setFloat32(off + 4, 22.7, true);
  if (version === 2) dv.setUint32(off + 8, seed, true);
  off += record;
  for (let i = 0; i < floats; i++) dv.setFloat32(off + i * 4, i / 100, true);
  return buf;
}
