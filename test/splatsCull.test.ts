import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { TILE_HEIGHT_SCENE, cameraFrustum, tileVisible, tileWorldBox } from '../src/splats/cull.js';

describe('splat tile frustum culling', () => {
  it('builds the tile column from its south-west placement (+x east, -z north)', () => {
    const box = tileWorldBox({ x: 100, y: 0, z: 50 }, 600);
    expect(box.min.x).toBe(100);
    expect(box.max.x).toBe(700);
    expect(box.max.z).toBe(50);
    expect(box.min.z).toBe(-550);
    expect(box.max.y).toBe(TILE_HEIGHT_SCENE);
    expect(box.min.y).toBeLessThan(0);           // dips below ground
    expect(tileWorldBox({ x: 0, y: 0, z: 0 }, -5).max.x).toBe(0); // negative size is clamped
  });

  it('keeps tiles in view and drops those behind the camera', () => {
    const cam = new THREE.PerspectiveCamera(50, 1.6, 0.5, 20000);
    cam.position.set(0, 400, 800);
    cam.lookAt(0, 0, 0);                          // looking north-ish, down
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const f = cameraFrustum(cam);
    expect(tileVisible(f, tileWorldBox({ x: -300, y: 0, z: 300 }, 600))).toBe(true);   // under the gaze
    expect(tileVisible(f, tileWorldBox({ x: -300, y: 0, z: 9000 }, 600))).toBe(false); // far behind
    expect(tileVisible(f, tileWorldBox({ x: 40000, y: 0, z: 0 }, 600))).toBe(false);   // far to the side
  });

  it('a tall tile just past the near edge still counts as visible', () => {
    const cam = new THREE.PerspectiveCamera(50, 1.6, 0.5, 20000);
    cam.position.set(0, 200, 0);
    cam.lookAt(0, 0, -600);                       // pitched over, looking north
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const f = cameraFrustum(cam);
    // a tile directly under the camera: its ground is out of frame but its column is not
    expect(tileVisible(f, tileWorldBox({ x: -300, y: 0, z: 300 }, 600))).toBe(true);
  });
});

describe('distance cutoff fades rather than pops', () => {
  it('eases a tile out over splatFadeMs and back in again', async () => {
    // Pure arithmetic of the fade step, mirroring SplatsLayer.distFadeStep().
    const fadeMs = 350;
    const step = (dt: number): number => dt / fadeMs;
    let fade = 1;
    let frames = 0;
    while (fade > 0 && frames < 100) {              // out
      fade = Math.max(0, fade - step(16));
      if (Math.abs(fade) < 0.01) fade = 0;
      frames++;
    }
    expect(fade).toBe(0);
    // ~350 ms at 16 ms per frame, give or take the 0.01 snap
    expect(frames).toBeGreaterThan(15);
    expect(frames).toBeLessThan(28);
    let back = 0;
    frames = 0;
    while (back < 1 && frames < 100) {              // and back in
      back = Math.min(1, back + step(16));
      if (Math.abs(back - 1) < 0.01) back = 1;
      frames++;
    }
    expect(back).toBe(1);
  });
});
