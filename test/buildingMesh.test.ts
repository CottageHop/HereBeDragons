import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeHbdb } from './helpers/hbdb.js';
import {
  BUILDING_KIND_WALL,
  buildingGeometry,
  createBuildingMaterial,
  parseBuildingMesh,
  setBuildingImagery
} from '../src/splats/buildingMesh.js';

describe('building meshes (HBDB)', () => {
  it('parses SplatMap\'s format: roofs map into the imagery, walls carry their own metres', () => {
    const d = parseBuildingMesh(makeHbdb());
    expect(d.vertices).toBe(6);
    expect(d.tileSize).toBeCloseTo(611.5, 3);
    expect([...d.kind]).toEqual([1, 1, 1, 2, 2, 2]);
    expect(d.uv[0]).toBeCloseTo(10 / 611.5, 6);
    expect(d.wall[7]).toBeCloseTo(22.7, 4);
    expect([...d.buildingRoof]).toEqual([200, 100, 50]);
    expect(d.nStyles).toBe(1);
    expect(d.styles[3]).toBeCloseTo(0.03, 6);
  });

  it('builds one geometry with per-vertex style and roof colour, and a material that takes the imagery', () => {
    const d = parseBuildingMesh(makeHbdb());
    const g = buildingGeometry(d);
    expect(g.getAttribute('position').count).toBe(6);
    expect(g.getAttribute('aKind').array[3]).toBe(BUILDING_KIND_WALL);
    expect(g.getAttribute('aRoof').normalized).toBe(true);
    const fade = { value: 0.5 };
    const mat = createBuildingMaterial(d, fade);
    expect(mat.uniforms.uLevelFade).toBe(fade); // shared with the tile's ground fade
    const quad = new THREE.Vector4(0, 1, 0, 0);
    expect(createBuildingMaterial(d, fade, quad).uniforms.uQuad.value).toBe(quad); // the splats' quadrant vector
    expect(mat.uniforms.uTileSize.value).toBeCloseTo(611.5, 3);
    expect(mat.uniforms.uHasImagery.value).toBe(0);
    const tex = new THREE.Texture();
    setBuildingImagery(mat, tex);
    expect(mat.uniforms.uImagery.value).toBe(tex);
    expect(mat.uniforms.uHasImagery.value).toBe(1);
    expect(() => parseBuildingMesh(new ArrayBuffer(32))).toThrow(/HBDB/);
  });
});
