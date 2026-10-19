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
    for (const uv of [[0.5, 0.5], [0.1, 0.2], [0.9, 0.95], [0.3, 0.05]] as const) {
      const r = reprojectUv(uv, viewProj(cam), viewProj(cam), cam.position)!;
      expect(r[0]).toBeCloseTo(uv[0], 4);
      expect(r[1]).toBeCloseTo(uv[1], 4);
    }
  });

  it('after a pan, a ground point is fetched from exactly where the previous frame drew it', () => {
    const prev = mapCamera(new THREE.Vector3(0, 0, 0), 180, 62);
    const cur = mapCamera(new THREE.Vector3(2.5, 0, -1.5), 180, 62);     // one frame of a fast pan
    for (const ground of [new THREE.Vector3(30, 0, -40), new THREE.Vector3(-120, 0, -250), new THREE.Vector3(5, 0, 60)]) {
      const uvNow = project(cur, ground);
      const r = reprojectUv(uvNow, viewProj(cur), viewProj(prev), cur.position)!;
      const uvPrev = project(prev, ground);
      expect(r[0]).toBeCloseTo(uvPrev[0], 4);
      expect(r[1]).toBeCloseTo(uvPrev[1], 4);
    }
  });

  it('a 10 m rooftop ~400 m away is well under a pixel out for one frame of motion', () => {
    // one 60 Hz frame of the fastest pan measured at this zoom moves the camera ~0.7 m; take 1 m
    const prev = mapCamera(new THREE.Vector3(0, 0, 0), 180, 62);
    const cur = mapCamera(new THREE.Vector3(1, 0, 0), 180, 62);
    // a point 10 m up, ~300 m ahead of the camera along its view
    const roof = new THREE.Vector3(40, 10, -260);
    const uvNow = project(cur, roof);
    const r = reprojectUv(uvNow, viewProj(cur), viewProj(prev), cur.position)!;
    const uvPrev = project(prev, roof);
    const errPx = Math.hypot((r[0] - uvPrev[0]) * 1280, (r[1] - uvPrev[1]) * 800);
    expect(errPx).toBeLessThan(0.5);
  });

  it('a rotation (bearing change) reprojects the sky exactly too', () => {
    const prev = mapCamera(new THREE.Vector3(0, 0, 0), 180, 74, 0);
    const cur = mapCamera(new THREE.Vector3(0, 0, 0), 180, 74, 1.5);
    const inv = viewProj(cur).clone().invert();
    // top of the frame at tilt 74 looks above the horizon
    const r = reprojectUv([0.5, 0.99], viewProj(cur), viewProj(prev), cur.position)!;
    // a far point along the current ray, where the previous camera saw it
    const far = new THREE.Vector3(0, 0.98, 1).applyMatrix4(inv);
    const uvPrev = project(prev, far);
    expect(r[0]).toBeCloseTo(uvPrev[0], 3);
    expect(r[1]).toBeCloseTo(uvPrev[1], 3);
  });
});

/** The previous frame's depth of a scene of ground plus one box tower, as the GPU would have it:
 *  the nearest hit along the camera's ray through `uv`, in window depth 0..1 (1 = nothing). */
function sceneDepth(cam: THREE.PerspectiveCamera, tower: THREE.Box3): (uv: [number, number]) => number {
  const vp = viewProj(cam);
  const inv = vp.clone().invert();
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  return (uv) => {
    const far = new THREE.Vector3(uv[0] * 2 - 1, uv[1] * 2 - 1, 1).applyMatrix4(inv);
    ray.set(cam.position, far.sub(cam.position).normalize());
    let best: THREE.Vector3 | null = ray.intersectBox(tower, hit) ? hit.clone() : null;
    if (ray.direction.y < 0) {
      const g = cam.position.clone().addScaledVector(ray.direction, -cam.position.y / ray.direction.y);
      if (!best || g.distanceTo(cam.position) < best.distanceTo(cam.position)) best = g;
    }
    if (!best) return 1;
    const c = new THREE.Vector4(best.x, best.y, best.z, 1).applyMatrix4(vp);
    return (c.z / c.w) * 0.5 + 0.5;
  };
}

describe('ReprojectPass — refined with the previous frame\'s depth', () => {
  // one frame of an orbit around a 250 m tower seen from 1.5 km: the camera moves ~37 m
  const tower = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 250, 20));
  const prev = mapCamera(new THREE.Vector3(0, 0, 0), 1500, 45, 0);
  const cur = mapCamera(new THREE.Vector3(0, 0, 0), 1500, 45, 2);
  const errPx = (a: readonly number[], b: readonly number[]): number =>
    Math.hypot((a[0] - b[0]) * 1280, (a[1] - b[1]) * 800);
  const depthAt = sceneDepth(prev, tower);
  const opts = { depthAt, seedHeight: 250 };

  it('lands a tall tower\'s facade and roof where the previous frame drew them', () => {
    for (const p of [new THREE.Vector3(5, 150, 20), new THREE.Vector3(0, 250, 0)]) {
      const uvNow = project(cur, p);
      const want = project(prev, p);
      const plane = reprojectUv(uvNow, viewProj(cur), viewProj(prev), cur.position)!;
      expect(errPx(plane, want)).toBeGreaterThan(3);            // the ground plane alone jumps
      const refined = reprojectUv(uvNow, viewProj(cur), viewProj(prev), cur.position, opts)!;
      expect(errPx(refined, want)).toBeLessThan(0.5);
    }
  });

  it('at the leading edge, prefers the tower over the ground it now hides', () => {
    // near the facade's top corner: from the ground seed the iteration settles on the ground just
    // past the silhouette — visible to the previous camera, behind the tower for the current one
    const p = new THREE.Vector3(-12, 240, 20);
    const uvNow = project(cur, p);
    const want = project(prev, p);
    const groundOnly = reprojectUv(uvNow, viewProj(cur), viewProj(prev), cur.position, { depthAt, seedHeight: 0 })!;
    expect(errPx(groundOnly, want)).toBeGreaterThan(3);
    expect(errPx(reprojectUv(uvNow, viewProj(cur), viewProj(prev), cur.position, opts)!, want)).toBeLessThan(0.5);
  });

  it('gets nearly every pixel of the tower right that the previous frame saw', () => {
    const inv = viewProj(cur).clone().invert();
    const prevInv = viewProj(prev).clone().invert();
    const visibleIn = (cam: THREE.PerspectiveCamera, camInv: THREE.Matrix4, uv: [number, number]): THREE.Vector3 | null => {
      const far = new THREE.Vector3(uv[0] * 2 - 1, uv[1] * 2 - 1, 1).applyMatrix4(camInv);
      const ray = new THREE.Ray(cam.position, far.sub(cam.position).normalize());
      const hit = new THREE.Vector3();
      return ray.intersectBox(tower, hit) ? hit.clone() : null;
    };
    let n = 0, planeBad = 0, bad = 0;
    for (let x = 560; x < 720; x += 2) for (let y = 300; y < 560; y += 2) {
      const uv: [number, number] = [x / 1280, y / 800];
      const p = visibleIn(cur, inv, uv);
      if (!p) continue;
      const want = project(prev, p);
      const seen = visibleIn(prev, prevInv, want);
      if (!seen || seen.distanceTo(p) > 0.5) continue;           // hidden from the previous camera
      n++;
      if (errPx(reprojectUv(uv, viewProj(cur), viewProj(prev), cur.position)!, want) > 1) planeBad++;
      if (errPx(reprojectUv(uv, viewProj(cur), viewProj(prev), cur.position, opts)!, want) > 1) bad++;
    }
    expect(n).toBeGreaterThan(500);
    expect(planeBad / n).toBeGreaterThan(0.3);
    expect(bad / n).toBeLessThan(0.01);
  });

  it('keeps the ground exact, and the sky on the far mapping', () => {
    for (const g of [new THREE.Vector3(300, 0, -200), new THREE.Vector3(-250, 0, 150)]) {
      const r = reprojectUv(project(cur, g), viewProj(cur), viewProj(prev), cur.position, opts)!;
      expect(errPx(r, project(prev, g))).toBeLessThan(0.05);
    }
    const sky = reprojectUv([0.5, 0.999], viewProj(cur), viewProj(prev), cur.position, { depthAt: () => 1, seedHeight: 100 })!;
    const plain = reprojectUv([0.5, 0.999], viewProj(cur), viewProj(prev), cur.position)!;
    expect(errPx(sky, [Math.min(1, Math.max(0, plain[0])), Math.min(1, Math.max(0, plain[1]))])).toBeLessThan(1e-6);
  });
});
