import * as THREE from 'three';

/**
 * Build a stepped gradient map (1D DataTexture) for MeshToonMaterial. The
 * material samples this with the light dot product to produce stepped shading.
 *
 * 3-band default: shadow / mid / lit. Each band is a flat value.
 *
 * Bands are deliberately HARSH (24% shadow → 51% mid → 100% lit) — combined
 * with the dimmed hemi/ambient in `Lights.ts` this gives the cel-shaded look
 * its actual punch. The previous 45/78/100 bands were drowned by the bright
 * indirect lighting, so building faces looked nearly flat regardless of sun
 * direction. The harsher gradient makes lit/shaded sides clearly distinct
 * even on the `'low'` quality tier where the outline pass is disabled.
 */
export function build3BandGradient(): THREE.DataTexture {
  //   shadow → 24% (deep, gives a clear cel-shaded "dark side")
  //   mid    → 51% (single transitional band — keeps the look stepped)
  //   lit    → 100% (= diffuse / swatch)
  const data = new Uint8Array([
    60, 60, 60, 255,
    130, 130, 130, 255,
    255, 255, 255, 255
  ]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function build5BandGradient(): THREE.DataTexture {
  const data = new Uint8Array([
    60, 60, 60, 255,
    120, 120, 120, 255,
    175, 175, 175, 255,
    220, 220, 220, 255,
    255, 255, 255, 255
  ]);
  const tex = new THREE.DataTexture(data, 5, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
