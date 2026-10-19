import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeHbdb } from './helpers/hbdb.js';
import {
  BUILDING_KIND_WALL,
  BUILDING_ROOF_METAL,
  BUILDING_STYLE_FLOATS,
  buildingGeometry,
  buildingStyleTexture,
  createBuildingDepthMaterial,
  createBuildingMaterial,
  disposeBuildingMaterial,
  parseBuildingMesh,
  setBuildingImagery
} from '../src/splats/buildingMesh.js';

describe('building meshes (HBDB)', () => {
  it('parses SplatMap\'s format: walls and roofs carry their own metres, houses their garage and roofing', () => {
    const d = parseBuildingMesh(makeHbdb());
    expect(d.version).toBe(3);
    expect(d.vertices).toBe(6);
    expect(d.tileSize).toBeCloseTo(611.5, 3);
    expect(d.mercatorScale).toBeCloseTo(1.32, 5);
    expect([...d.kind]).toEqual([1, 1, 1, 2, 2, 2]);
    expect([...d.flags]).toEqual([0, 0, 0, 1, 1, 1]);
    expect(d.uv[2]).toBeCloseTo(7.6, 5);                       // roof: along the eave, metres
    expect(d.wall[7]).toBeCloseTo(22.7, 4);
    expect([...d.buildingRoof]).toEqual([200, 100, 50]);
    expect(d.buildingSeed[0]).toBe(0xC0FFEE);
    expect(d.buildingEave[0]).toBeCloseTo(22.7, 4);
    expect(d.buildingGarage[0]).toBeCloseTo(3.5, 5);
    expect(d.buildingGarage[1]).toBeCloseTo(4.9, 5);
    expect(d.buildingRoofing[0]).toBe(BUILDING_ROOF_METAL);
    expect(d.nStyles).toBe(1);
    expect(d.styles.length).toBe(BUILDING_STYLE_FLOATS);
    expect(d.styles[3]).toBeCloseTo(0.03, 6);
    expect(d.styles[25]).toBeCloseTo(0.25, 6);                 // the facade program's slot
    expect(d.styles[37]).toBeCloseTo(0.37, 6);                 // the door colour's last float
  });

  it('reads versions 1 and 2 as version 3: defaults, no garage, shingles, roofs in metres', () => {
    for (const v of [1, 2] as const) {
      const d = parseBuildingMesh(makeHbdb(v));
      expect(d.version).toBe(v);
      expect(d.buildingSeed[0]).toBe(v === 1 ? 0 : 0xC0FFEE);
      expect(d.buildingGarage[0]).toBe(-1);
      expect(d.buildingRoofing[0]).toBe(0);
      expect(d.styles.length).toBe(BUILDING_STYLE_FLOATS);
      expect(d.styles[35]).toBeCloseTo(0.35, 6);               // the default door colour
      expect(d.uv[0]).toBeCloseTo(10 / 1.32, 4);               // roof: world-aligned metres
      expect(d.uv[6]).toBe(0);                                  // walls untouched
    }
    const v1 = parseBuildingMesh(makeHbdb(1));
    expect(v1.styles[24]).toBeCloseTo(0.24, 6);                // its own last float
    expect(v1.styles[25]).toBe(0);                              // program 0: a house
    expect(v1.styles[29]).toBeCloseTo(1.5, 6);                  // the default mullion spacing
  });

  it('builds one geometry with per-vertex style, roof colour and seed, and a material that takes the imagery', () => {
    const d = parseBuildingMesh(makeHbdb());
    const g = buildingGeometry(d);
    expect(g.getAttribute('position').count).toBe(6);
    expect(g.getAttribute('aKind').array[3]).toBe(BUILDING_KIND_WALL);
    expect(g.getAttribute('aRoof').normalized).toBe(true);
    const seed = g.getAttribute('aSeed');
    expect(seed.normalized).toBe(true);
    expect(new Set(seed.array).size).toBe(1);                  // one building, one variation
    const other = buildingGeometry(parseBuildingMesh(makeHbdb(3, 7))).getAttribute('aSeed').array[0];
    expect(other).not.toBe(seed.array[0]);
    // per vertex: eave, the garage only on the street wall, roofing (+8 on the street wall)
    const house = g.getAttribute('aHouse').array as Float32Array;
    expect(house[0]).toBeCloseTo(22.7, 4);
    expect(house[1]).toBe(-1);                                  // a roof vertex: no garage
    expect(house[3]).toBe(BUILDING_ROOF_METAL);
    expect(house[3 * 4 + 1]).toBeCloseTo(3.5, 5);              // a street-wall vertex
    expect(house[3 * 4 + 2]).toBeCloseTo(4.9, 5);
    expect(house[3 * 4 + 3]).toBe(BUILDING_ROOF_METAL + 8);
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
    disposeBuildingMaterial(mat);
  });

  it('packs the styles one row each into a float texture, 10 texels to a row, colours linear', () => {
    const d = parseBuildingMesh(makeHbdb());
    const tex = buildingStyleTexture(d);
    expect(tex.image.width).toBe(10);
    expect(tex.image.height).toBe(1);
    const data = tex.image.data as Float32Array;
    expect(data[25]).toBeCloseTo(0.25, 6);                     // program: as is
    expect(data[34]).toBeCloseTo(0.34, 6);                     // tint: as is
    expect(data[3]).toBeCloseTo(Math.pow(0.03, 2.2), 8);       // trim red: linear
    expect(data[36]).toBeCloseTo(Math.pow(0.36, 2.2), 6);      // door green: linear
    expect(data[38]).toBe(0);                                  // padding
    const mat = createBuildingMaterial(d);
    expect((mat.uniforms.uStyleTex.value as THREE.DataTexture).image.width).toBe(10);
  });

  it('has a depth-only twin for the pre-pass that fades with it', () => {
    const fade = { value: 0.4 };
    const mat = createBuildingMaterial(parseBuildingMesh(makeHbdb()), fade);
    const depth = createBuildingDepthMaterial(mat);
    expect(depth.colorWrite).toBe(false);
    expect(depth.uniforms).toBe(mat.uniforms);                 // one fade, one quadrant vector
    expect(depth.uniforms.uLevelFade).toBe(fade);
    expect(depth.vertexShader).toBe(mat.vertexShader);         // the same depths, bit for bit
    expect(depth.side).toBe(mat.side);
  });
});
