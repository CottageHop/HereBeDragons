import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Projection } from '../src/core/Projection.js';
import { MapCameraController } from '../src/controls/MapCameraController.js';

/** The little of a canvas MapControls touches (node has no DOM). */
function fakeCanvas(): HTMLCanvasElement {
  const noop = (): void => {};
  const root = { addEventListener: noop, removeEventListener: noop };
  return {
    clientWidth: 800, clientHeight: 600, style: {},
    addEventListener: noop, removeEventListener: noop,
    getRootNode: () => root, ownerDocument: root
  } as unknown as HTMLCanvasElement;
}

type Internals = { _panOffset: THREE.Vector3; _sphericalDelta: THREE.Spherical };

describe('MapCameraController — the inertia glide ends once it is sub-pixel', () => {
  const make = (): { cam: MapCameraController; ctl: Internals } => {
    const cam = new MapCameraController(fakeCanvas(), new Projection(47.7079, -116.7709), { zoom: 16, tilt: 60, bearing: 0 });
    cam.update(0);
    return { cam, ctl: cam.controls as unknown as Internals };
  };

  it('a released fling decays visibly, then stops instead of creeping for seconds', () => {
    const { cam, ctl } = make();
    let changes = 0;
    cam.onChange = () => { changes++; };
    const dist = cam.three.position.distanceTo(cam.controls.target);
    ctl._panOffset.set(dist * 0.05, 0, 0);       // a fling: a few px a frame to begin with
    let frames = 0;
    while (ctl._panOffset.lengthSq() > 0 && frames < 2000) { cam.update(1 / 60); frames++; }
    // Plain damping (5 % a frame) would take ~200 frames to fall under 0.01 px; this stops near 0.25 px.
    expect(ctl._panOffset.lengthSq()).toBe(0);
    expect(frames).toBeLessThan(120);
    expect(changes).toBeGreaterThan(10);           // the visible part of the glide still plays
    const after = changes;
    for (let k = 0; k < 300; k++) cam.update(1 / 60);
    expect(changes).toBe(after);                   // and then nothing: no late micro-moves
  });

  it('never cuts a live gesture, however slow', () => {
    const { cam, ctl } = make();
    cam.controls.dispatchEvent({ type: 'start' } as never);
    ctl._panOffset.set(1e-4, 0, 0);
    cam.update(1 / 60);
    expect(ctl._panOffset.lengthSq()).toBeGreaterThan(0);
    cam.controls.dispatchEvent({ type: 'end' } as never);
    cam.update(1 / 60);
    expect(ctl._panOffset.lengthSq()).toBe(0);
  });
});

describe('MapCameraController — inertia is defined in seconds, not frames', () => {
  const glide = (dt: number, seconds: number): { travelled: number; frames: number } => {
    const cam = new MapCameraController(fakeCanvas(), new Projection(47.7079, -116.7709), { zoom: 16, tilt: 60, bearing: 0 });
    cam.update(0);
    const ctl = cam.controls as unknown as Internals;
    const dist = cam.three.position.distanceTo(cam.controls.target);
    const start = cam.controls.target.clone();
    ctl._panOffset.set(dist * 0.6, 0, 0);
    const frames = Math.round(seconds / dt);
    for (let k = 0; k < frames; k++) cam.update(dt);
    return { travelled: cam.controls.target.distanceTo(start), frames };
  };

  it('a fling travels the same distance in the same wall time at 60 fps and at 20 fps', () => {
    const fast = glide(1 / 60, 0.5);
    const slow = glide(1 / 20, 0.5);
    expect(fast.frames).toBe(30);
    expect(slow.frames).toBe(10);
    expect(slow.travelled / fast.travelled).toBeCloseTo(1, 1);
    // and it is a real glide, not a snap: well under the full remaining offset after half a second
    const cam = new MapCameraController(fakeCanvas(), new Projection(47.7079, -116.7709), { zoom: 16, tilt: 60, bearing: 0 });
    const full = cam.three.position.distanceTo(cam.controls.target) * 0.6;
    expect(fast.travelled).toBeLessThan(full * 0.95);
    expect(fast.travelled).toBeGreaterThan(full * 0.5);
  });

  it('a long frame (hidden tab) is treated as a bounded step, not a jump to the end', () => {
    const a = glide(0.1, 0.1);
    const b = glide(2, 2);          // one 2 s "frame"
    expect(b.frames).toBe(1);
    expect(b.travelled).toBeCloseTo(a.travelled, 6);
  });
});
