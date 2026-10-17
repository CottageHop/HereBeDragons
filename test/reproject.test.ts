import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { reprojectUv } from '../src/rendering/ReprojectPass.js';

/** A map camera: `distance` from a ground target, tilted `tiltDeg` from straight down. */
function mapCamera(target: THREE.Vector3, distance: number, tiltDeg: number, bearingDeg = 0): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1280 / 800, 10, 60_000);
  const tilt = (tiltDeg * Math.PI) / 180;
  const bearing = (bearingDeg * Math.PI) / 180;
  cam.position.set(
    target.x + distance * Math.sin(tilt) * Math.sin(bearing),
    target.y + distance * Math.cos(tilt),
    target.z + distance * Math.sin(tilt) * Math.cos(bearing)
  );
  cam.lookAt(target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}
const viewProj = (c: THREE.Camera): THREE.Matrix4 => new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
const project = (c: THREE.Camera, p: THREE.Vector3): [number, number] => {
  const v = p.clone().project(c);
  return [v.x * 0.5 + 0.5, v.y * 0.5 + 0.5];
};

describe('ReprojectPass — ground-plane reprojection of the previous frame', () => {
  it('with the camera unmoved every pixel maps to itself', () => {
    const cam = mapCamera(new THREE.Vector3(0, 0, 0), 180, 62);
    const inv = viewProj(cam).clone().invert();
    for (const uv of [[0.5, 0.5], [0.1, 0.2], [0.9, 0.95], [0.3, 0.05]] as const) {
      const r = reprojectUv(uv, inv, viewProj(cam), cam.position)!;
      expect(r[0]).toBeCloseTo(uv[0], 4);
      expect(r[1]).toBeCloseTo(uv[1], 4);
    }
  });

  it('after a pan, a ground point is fetched from exactly where the previous frame drew it', () => {
    const prev = mapCamera(new THREE.Vector3(0, 0, 0), 180, 62);
    const cur = mapCamera(new THREE.Vector3(2.5, 0, -1.5), 180, 62);     // one frame of a fast pan
    const inv = viewProj(cur).clone().invert();
    for (const ground of [new THREE.Vector3(30, 0, -40), new THREE.Vector3(-120, 0, -250), new THREE.Vector3(5, 0, 60)]) {
      const uvNow = project(cur, ground);
      const r = reprojectUv(uvNow, inv, viewProj(prev), cur.position)!;
      const uvPrev = project(prev, ground);
      expect(r[0]).toBeCloseTo(uvPrev[0], 4);
      expect(r[1]).toBeCloseTo(uvPrev[1], 4);
    }
  });

  it('a 10 m rooftop ~400 m away is well under a pixel out for one frame of motion', () => {
    // one 60 Hz frame of the fastest pan measured at this zoom moves the camera ~0.7 m; take 1 m
    const prev = mapCamera(new THREE.Vector3(0, 0, 0), 180, 62);
    const cur = mapCamera(new THREE.Vector3(1, 0, 0), 180, 62);
    const inv = viewProj(cur).clone().invert();
    // a point 10 m up, ~300 m ahead of the camera along its view
    const roof = new THREE.Vector3(40, 10, -260);
    const uvNow = project(cur, roof);
    const r = reprojectUv(uvNow, inv, viewProj(prev), cur.position)!;
    const uvPrev = project(prev, roof);
    const errPx = Math.hypot((r[0] - uvPrev[0]) * 1280, (r[1] - uvPrev[1]) * 800);
    expect(errPx).toBeLessThan(0.5);
  });

  it('a rotation (bearing change) reprojects the sky exactly too', () => {
    const prev = mapCamera(new THREE.Vector3(0, 0, 0), 180, 74, 0);
    const cur = mapCamera(new THREE.Vector3(0, 0, 0), 180, 74, 1.5);
    const inv = viewProj(cur).clone().invert();
    // top of the frame at tilt 74 looks above the horizon
    const r = reprojectUv([0.5, 0.99], inv, viewProj(prev), cur.position)!;
    // a far point along the current ray, where the previous camera saw it
    const far = new THREE.Vector3(0, 0.98, 1).applyMatrix4(inv);
    const uvPrev = project(prev, far);
    expect(r[0]).toBeCloseTo(uvPrev[0], 3);
    expect(r[1]).toBeCloseTo(uvPrev[1], 3);
  });
});
