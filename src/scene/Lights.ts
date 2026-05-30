import * as THREE from 'three';

/**
 * A theme-supplied lighting look. Every field optional — omitted fields fall
 * back to the defaults baked into {@link createLights}. Colors are hex strings
 * so a theme can declare its whole atmosphere (palette + clouds + light) as
 * plain JSON. Drives the warm golden-hour key + soft sky fill that gives the
 * Ghibli theme its painted glow. Applied via {@link SceneRoot.applyLightPreset};
 * passing `null` there restores the neutral defaults.
 */
export interface LightPreset {
  /** Key-light (sun) color. */
  sun?: string;
  /** Key-light intensity. Default 1.0. */
  sunIntensity?: number;
  /** Back/fill directional intensity. Default 0.10. */
  fillIntensity?: number;
  /** Flat ambient intensity. Default 0.05. Keep low or toon shading flattens. */
  ambientIntensity?: number;
  /** Hemisphere sky (up) color. */
  hemiSky?: string;
  /** Hemisphere ground (down) color. */
  hemiGround?: string;
  /** Hemisphere intensity. Default 0.25. Above ~0.4 starts cancelling shading. */
  hemiIntensity?: number;
}

export function createLights(): {
  sun: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  group: THREE.Group;
} {
  const group = new THREE.Group();
  group.name = 'Lights';

  // Sun dominates; indirect lighting is kept LOW so the harsh toon gradient
  // (see GradientMaps.ts: 24% / 51% / 100%) actually reads on building faces.
  // The previous setup (hemi 0.80 + ambient 0.15) flooded shaded faces with
  // ~0.95 of indirect light, pinning everything at near-fully-lit regardless
  // of sun direction and effectively cancelling the toon shading.
  //
  // Per-light role:
  //   sun     1.0  — full-strength key light, drives the lit/shaded split
  //   fill    0.10 — keeps back-of-building from going pure-shadow color
  //   ambient 0.05 — barely-there flat lift to avoid crushed blacks
  //   hemi    0.25 — soft sky-up / ground-down tint, mostly for top surfaces
  //
  // Brightness on a building face (3-band gradient, MeshToonMaterial sums
  // each light's gradient-mapped contribution independently):
  //   Lit face   : sun·1.00 + fill·0.24 ·0.10 + 0.05 + 0.25 ≈ 1.33 → clamps to 1.0
  //   Shaded face: sun·0.24 + fill·1.00 ·0.10 + 0.05 + 0.25 ≈ 0.64
  // → lit faces show the swatch as authored; shaded faces drop to ~64%
  //   brightness, giving a clear cel-shaded silhouette on every building.
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(800, 1200, 600);
  sun.target.position.set(0, 0, 0);
  group.add(sun);
  group.add(sun.target);

  const fill = new THREE.DirectionalLight(0xffffff, 0.10);
  fill.position.set(-600, 800, -400);
  fill.target.position.set(0, 0, 0);
  group.add(fill);
  group.add(fill.target);

  const ambient = new THREE.AmbientLight(0xffffff, 0.05);
  group.add(ambient);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25);
  group.add(hemi);

  return { sun, fill, ambient, hemi, group };
}
