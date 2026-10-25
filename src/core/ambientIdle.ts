/**
 * Ambient idle — how alive the map's continuous animations (wind in the trees and grass, the
 * shoreline foam, drifting motes) are, as one eased energy in [0, 1].
 *
 * The animations are alive while the user is present: a gesture in progress, or a camera move
 * or pointer crossing within `idleMs`. Past that the energy eases toward 0 — the wind dies down
 * over about a second — and at 0 the layers' clocks stand still, so a map nobody is touching
 * draws no frame at all. On the next interaction it rises again, quickly.
 *
 * Pure: no THREE, no DOM, no clock — fed by the render loop and unit-testable.
 */
import { approach, tauFor } from './motion.js';

/** Default `performance.ambientIdleMs`. */
export const AMBIENT_IDLE_MS = 4000;
/** The breeze picks up over about this long on the next interaction… */
export const AMBIENT_RISE_MS = 500;
/** …and dies down over about this long once the user has gone idle. */
export const AMBIENT_FALL_MS = 1200;

export interface AmbientIdleInput {
  /** `performance.now()` for this tick. */
  now: number;
  /** When the user last did something: the later of the camera's last move and the pointer's
   *  last crossing of the map. */
  lastActivityMs: number;
  /** A drag / pinch / wheel gesture is in progress (the map is held). */
  gesturePressed: boolean;
  /** `performance.ambientIdleMs`: how long the animations outlive the last interaction. */
  idleMs: number;
  /** The tick's length, ms. */
  dtMs: number;
  /** `prefers-reduced-motion`: no easing, the energy jumps to its target. */
  reducedMotion: boolean;
}

/** Whether the user counts as present for the ambient animations. */
export function ambientActive(i: Pick<AmbientIdleInput, 'now' | 'lastActivityMs' | 'gesturePressed' | 'idleMs'>): boolean {
  return i.gesturePressed || i.now - i.lastActivityMs <= i.idleMs;
}

/**
 * One tick of the energy: returns the new value given the previous one. Settles exactly on 0 or
 * 1 (never a lingering 0.004 that would keep the layers' clocks ticking).
 */
export function stepAmbientEnergy(energy: number, i: AmbientIdleInput): number {
  const target = ambientActive(i) ? 1 : 0;
  if (energy === target) return energy;
  if (i.reducedMotion) return target;
  const tau = tauFor(target > energy ? AMBIENT_RISE_MS : AMBIENT_FALL_MS);
  let next = energy + (target - energy) * approach(i.dtMs, tau);
  if (Math.abs(target - next) < 0.01) next = target;
  return next;
}
