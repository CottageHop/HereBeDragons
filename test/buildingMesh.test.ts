import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeHbdb } from './helpers/hbdb.js';
import {
  BUILDING_KIND_WALL,
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
  it('parses SplatMap\'s format: roofs map into the imagery, walls carry their own metres', () => {
    const d = parseBuildingMesh(makeHbdb());
    expect(d.version).toBe(2);
    expect(d.vertices).toBe(6);
    expect(d.tileSize).toBeCloseTo(611.5, 3);
    expect([...d.kind]).toEqual([1, 1, 1, 2, 2, 2]);
    expect(d.uv[0]).toBeCloseTo(10 / 611.5, 6);
    expect(d.wall[7]).toBeCloseTo(22.7, 4);
    expect([...d.buildingRoof]).toEqual([200, 100, 50]);
    expect(d.buildingSeed[0]).toBe(0xC0FFEE);
    expect(d.nStyles).toBe(1);
    expect(d.styles.length).toBe(BUILDING_STYLE_FLOATS);
    expect(d.styles[3]).toBeCloseTo(0.03, 6);
    expect(d.styles[25]).toBeCloseTo(0.25, 6);                 // the facade program's slot
  });

  it('reads version 1 as houses: styles padded with the defaults, no seeds', () => {
    const d = parseBuildingMesh(makeHbdb(1));
    expect(d.version).toBe(1);
    expect(d.buildingSeed[0]).toBe(0);
    expect(d.styles.length).toBe(BUILDING_STYLE_FLOATS);
    expect(d.styles[24]).toBeCloseTo(0.24, 6);                 // its own last float
    expect(d.styles[25]).toBe(0);                              // program 0: a house
    expect(d.styles[29]).toBeCloseTo(1.5, 6);                  // the default mullion spacing
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
    const other = buildingGeometry(parseBuildingMesh(makeHbdb(2, 7))).getAttribute('aSeed').array[0];
    expect(other).not.toBe(seed.array[0]);
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

  it('packs the styles one row each into a float texture, 9 texels to a row', () => {
    const d = parseBuildingMesh(makeHbdb());
    const tex = buildingStyleTexture(d);
    expect(tex.image.width).toBe(9);
    expect(tex.image.height).toBe(1);
    const data = tex.image.data as Float32Array;
    expect(data[25]).toBeCloseTo(0.25, 6);
    expect(data[34]).toBeCloseTo(0.34, 6);
    expect(data[35]).toBe(0);                                  // padding
    const mat = createBuildingMaterial(d);
    expect((mat.uniforms.uStyleTex.value as THREE.DataTexture).image.width).toBe(9);
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
