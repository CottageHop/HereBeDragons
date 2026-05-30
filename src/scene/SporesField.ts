import * as THREE from 'three';

/**
 * Own render layer so the composer's normal/outline pass can skip the spores —
 * they're a custom billboard shader the MeshNormalMaterial override can't run.
 */
export const SPORES_THREE_LAYER = 6;

const BOX_XZ = 620; // horizontal extent of the wrap volume around the camera (m)
const BOX_Y = 150; // vertical band height (m)
const FLOOR_Y = 5; // bottom of the band

/**
 * Drifting spore / pollen motes — the soft glowing flecks that fill the air in
 * a Ghibli frame. A fixed pool of camera-facing billboards is wrapped (modulo)
 * into a box that follows the camera in XZ, so coverage is effectively infinite
 * from a small instance count, and the motes keep true world-space parallax as
 * the camera pans (they don't stick to the screen). Added straight to the scene
 * (not a tile layer), so it has no PMTiles/worker dependency. Theme-gated +
 * zoom-gated; animates only while visible.
 */
export class SporesField {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geo: THREE.InstancedBufferGeometry;
  private time = 0;
  /** Theme wants spores (set on theme apply). */
  private enabled = false;
  /** Currently shown (enabled AND zoomed in enough). */
  private shown = false;
  private readonly minZoom: number;

  constructor(count = 520, minZoom = 14) {
    this.minZoom = minZoom;
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3)
    );
    this.geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);

    const base = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      base[i * 3 + 0] = Math.random() * BOX_XZ;
      base[i * 3 + 1] = Math.random() * BOX_Y;
      base[i * 3 + 2] = Math.random() * BOX_XZ;
      seed[i] = Math.random();
    }
    this.geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 3));
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    this.geo.instanceCount = count;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(BOX_XZ, BOX_Y, BOX_XZ) },
        uFloorY: { value: FLOOR_Y },
        uSize: { value: 1.7 },
        uColor: { value: new THREE.Color('#fff2d2') },
        uOpacity: { value: 0.6 }
      },
      vertexShader: SPORES_VERT,
      fragmentShader: SPORES_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false; // wrapped around the camera; never cull
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.layers.set(SPORES_THREE_LAYER);
  }

  /** Theme toggle — whether this theme wants drifting spores at all. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.shown) {
      this.shown = false;
      this.mesh.visible = false;
    }
  }

  /** Optional colour override (defaults to a warm near-white). */
  setColor(hex: string): void {
    (this.material.uniforms.uColor.value as THREE.Color).set(hex);
  }

  /**
   * @returns true if a redraw is needed — either the visibility gate flipped,
   *   or the motes are showing and their drift advanced.
   */
  update(dt: number, cameraTarget: THREE.Vector3, zoom: number): boolean {
    const shouldShow = this.enabled && zoom >= this.minZoom;
    const flipped = shouldShow !== this.shown;
    if (flipped) {
      this.shown = shouldShow;
      this.mesh.visible = shouldShow;
    }
    if (!this.shown) return flipped;
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    (this.material.uniforms.uCamPos.value as THREE.Vector3).set(cameraTarget.x, 0, cameraTarget.z);
    return true;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

const SPORES_VERT = /* glsl */ `
attribute vec3 aBase;
attribute float aSeed;
uniform float uTime;
uniform vec3 uCamPos;   // xz = camera target, y unused
uniform vec3 uBox;
uniform float uFloorY;
uniform float uSize;
varying vec2 vUv;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = aSeed;
  // Gentle drift: a steady breeze in XZ + a slow per-mote vertical bob.
  vec3 drift = vec3(uTime * 4.0, sin(uTime * 0.5 + aSeed * 6.2831) * 4.0, uTime * 1.6);
  vec3 p = aBase + drift;
  // Wrap into a box that follows the camera in XZ (infinite coverage from a
  // small pool); the vertical band is fixed in world space.
  float minX = uCamPos.x - uBox.x * 0.5;
  float minZ = uCamPos.z - uBox.z * 0.5;
  vec3 wp;
  wp.x = mod(p.x - minX, uBox.x) + minX;
  wp.y = mod(p.y, uBox.y) + uFloorY;
  wp.z = mod(p.z - minZ, uBox.z) + minZ;
  // Camera-facing billboard.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float sz = uSize * (0.55 + fract(aSeed * 13.0) * 0.9);
  vec3 worldPos = wp + camRight * (position.x * sz) + camUp * (position.y * sz);
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

const SPORES_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vSeed;
void main() {
  // Soft round glow with a brighter core.
  float d = length(vUv - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.15, d);
  a *= a;
  if (a < 0.02) discard;
  float b = 0.7 + fract(vSeed * 7.0) * 0.3; // per-mote brightness variety
  gl_FragColor = vec4(uColor * b, a * uOpacity);
}
`;
