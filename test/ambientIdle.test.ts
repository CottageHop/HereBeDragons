import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  AMBIENT_FALL_MS,
  AMBIENT_IDLE_MS,
  AMBIENT_RISE_MS,
  ambientActive,
  stepAmbientEnergy
} from '../src/core/ambientIdle.js';
import { LayerRegistry } from '../src/scene/LayerRegistry.js';
import { SporesField } from '../src/scene/SporesField.js';
import type { Layer } from '../src/layers/Layer.js';

const base = { gesturePressed: false, idleMs: AMBIENT_IDLE_MS, dtMs: 16.7, reducedMotion: false };

/** Run the energy from `start` for `ms` of 60 Hz ticks with the user idle since t=0. */
const runIdle = (start: number, ms: number, idleMs = AMBIENT_IDLE_MS): number => {
  let e = start;
  for (let t = 0; t < ms; t += 16.7) e = stepAmbientEnergy(e, { ...base, idleMs, now: t, lastActivityMs: 0 });
  return e;
};

describe('ambient idle — the wind dies down on a map nobody is touching', () => {
  it('stays fully alive while the user is present', () => {
    expect(ambientActive({ now: 1000, lastActivityMs: 0, gesturePressed: false, idleMs: AMBIENT_IDLE_MS })).toBe(true);
    expect(ambientActive({ now: 10_000, lastActivityMs: 0, gesturePressed: true, idleMs: AMBIENT_IDLE_MS })).toBe(true);
    expect(stepAmbientEnergy(1, { ...base, now: 1000, lastActivityMs: 0 })).toBe(1);
  });

  it('goes idle only after ambientIdleMs, then eases to exactly 0 within ~3 × the fall time', () => {
    expect(runIdle(1, AMBIENT_IDLE_MS)).toBe(1);
    const mid = runIdle(1, AMBIENT_IDLE_MS + AMBIENT_FALL_MS / 3);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    expect(runIdle(1, AMBIENT_IDLE_MS + AMBIENT_FALL_MS * 3)).toBe(0);
  });

  it('picks up again quickly on the next interaction, settling on exactly 1', () => {
    let e = 0;
    for (let t = 0; t < AMBIENT_RISE_MS * 3; t += 16.7) e = stepAmbientEnergy(e, { ...base, now: t, lastActivityMs: t });
    expect(e).toBe(1);
    const early = stepAmbientEnergy(0, { ...base, now: 0, lastActivityMs: 0 });
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(1);
  });

  it('Infinity never idles; 0 is alive only while the camera moves this tick', () => {
    expect(runIdle(1, 60_000, Infinity)).toBe(1);
    expect(stepAmbientEnergy(1, { ...base, idleMs: 0, now: 100, lastActivityMs: 100 })).toBe(1);
    expect(stepAmbientEnergy(1, { ...base, idleMs: 0, now: 100, lastActivityMs: 99 })).toBeLessThan(1);
  });

  it('jumps straight to the target under prefers-reduced-motion', () => {
    expect(stepAmbientEnergy(1, { ...base, reducedMotion: true, now: 10_000, lastActivityMs: 0 })).toBe(0);
    expect(stepAmbientEnergy(0, { ...base, reducedMotion: true, now: 10, lastActivityMs: 0 })).toBe(1);
  });
});

describe('LayerRegistry.setTimeScale — a stilled layer reports nothing dirty', () => {
  const makeLayer = (): Layer & { dts: number[] } => {
    const dts: number[] = [];
    return {
      name: 'trees',
      dts,
      build: () => new THREE.Group(),
      update: (dt: number) => { dts.push(dt); return dt > 0; }
    } as unknown as Layer & { dts: number[] };
  };

  it('scales the dt the layer sees and reports dirty only while time advances', () => {
    const reg = new LayerRegistry();
    const trees = makeLayer();
    reg.register('trees', trees);
    expect(reg.update(0.016)).toBe(true);
    reg.setTimeScale('trees', 0.5);
    expect(reg.update(0.016)).toBe(true);
    expect(trees.dts[1]).toBeCloseTo(0.008);
    reg.setTimeScale('trees', 0);
    expect(reg.update(0.016)).toBe(false);
    expect(trees.dts[2]).toBe(0);
    reg.setTimeScale('trees', null);
    expect(reg.update(0.016)).toBe(true);
    expect(trees.dts[3]).toBeCloseTo(0.016);
  });

  it('composes with a throttle: the banked time is scaled too', () => {
    const reg = new LayerRegistry();
    const trees = makeLayer();
    reg.register('trees', trees);
    reg.setThrottle('trees', 100, true);
    reg.setTimeScale('trees', 0.25);
    for (let i = 0; i < 6; i++) reg.update(0.02); // 120 ms banked → one tick of 30 ms
    expect(trees.dts.length).toBe(1);
    expect(trees.dts[0]).toBeCloseTo(0.03);
  });
});

describe('SporesField.update with dt = 0', () => {
  it('reports nothing dirty when the motes stand still and the camera has not moved', () => {
    const spores = new SporesField();
    spores.setEnabled(true);
    const target = new THREE.Vector3(10, 0, 20);
    expect(spores.update(0.016, target, 16)).toBe(true); // shown: animating
    expect(spores.update(0, target, 16)).toBe(false);     // stilled, same camera
    expect(spores.update(0, new THREE.Vector3(11, 0, 20), 16)).toBe(true); // camera moved under them
    spores.dispose();
  });
});
