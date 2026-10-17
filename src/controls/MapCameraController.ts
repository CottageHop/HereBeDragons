import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { BoundingBox, CameraView, FlyToOptions } from '../types.js';
import type { Projection } from '../core/Projection.js';

export interface CameraInitOptions {
  zoom: number;
  tilt: number;
  bearing: number;
}

/**
 * Maps logical zoom <-> camera distance. The constant is chosen so that
 * zoom=15 corresponds to distance=512 meters from target — comfortable city view.
 */
const ZOOM_BASE_DISTANCE = 512 * 2 ** 15; // distance = ZOOM_BASE_DISTANCE * 2^-zoom

export function zoomToDistance(zoom: number): number {
  return ZOOM_BASE_DISTANCE * 2 ** -zoom;
}

function distanceToZoom(distance: number): number {
  return Math.log2(ZOOM_BASE_DISTANCE / distance);
}

const DEG = Math.PI / 180;
/** Glide step (CSS px per reference frame) below which the inertia tail is dropped (see
 *  endSubpixelGlide). */
export const GLIDE_STOP_PX = 0.25;
/**
 * Inertia / smoothing per REFERENCE frame (1/60 s). MapControls applies `dampingFactor` once per
 * `update()`, i.e. per frame, so on its own the glide would decelerate three times as fast through
 * a 50 ms frame as through a 17 ms one — the motion itself would jitter with the frame time, and a
 * fling would travel a different distance at 30 fps than at 60. `update(dt)` rescales the factor
 * to the frame's actual length so the curve is defined in seconds, like a platform scroll.
 */
export const BASE_DAMPING = 0.05;
const REF_FRAME_S = 1 / 60;
/** Longest frame the damping is scaled for (a hidden-tab resume is not one long glide step). */
const MAX_DAMPING_DT_S = 0.1;
const RAD = 180 / Math.PI;

/** MapControls' closest approach when no zoom range is set (≈ zoom 19.4). */
const DEFAULT_MIN_DISTANCE = 25;
const DEFAULT_MAX_DISTANCE = 30_000;
/** How long `setMaxZoomCap` takes to ease a too-close camera out. */
export const ZOOM_CAP_EASE_MS = 600;

/** Render an argument for an error message: type for objects, value for primitives. */
export function describeArg(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') return Array.isArray(v) ? 'an array' : 'an object';
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
  return `${typeof v} ${JSON.stringify(v)}`;
}

export class MapCameraController {
  /** Pan speed for mouse drag (desktop) — three.js MapControls default. */
  private static readonly MOUSE_PAN_SPEED = 1.0;
  /**
   * Pan speed for touch/swipe (phones). MapControls uses one panSpeed for all
   * input, and a finger swipe panned noticeably slower than a mouse drag felt
   * right, so touch gets a bump while the mouse stays at the desktop default.
   */
  private static readonly TOUCH_PAN_SPEED = 2.25;

  readonly three: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  onChange?: () => void;
  /**
   * Fired the instant the user grabs the map — pointer-drag, pinch, or wheel
   * (MapControls dispatches its `start` event for all three). The map uses
   * this to proactively suspend tile-mesh construction so the gesture owns the
   * main thread from frame one. Paired with `onInteractionEnd`.
   */
  onInteractionStart?: () => void;
  /**
   * Fired when the gesture's MapControls drag/pinch/wheel ends. Note the
   * damping inertia tail keeps the camera (and `onChange`) moving for a beat
   * after this — the map keeps the gate closed for a short settle window past
   * this event rather than resuming builds immediately.
   */
  onInteractionEnd?: () => void;

  /** A MapControls gesture (drag, pinch, wheel) is in progress — between its start and end. */
  private gestureLive = false;
  private projection: Projection;
  private bounds: BoundingBox | null = null;
  private dom: HTMLCanvasElement;
  private onPointerDown: (e: PointerEvent) => void;
  /**
   * True while a floor-badge reveal has lifted the tilt/zoom limits via
   * suspendLimits(). Guards against a double-suspend and tells the range
   * setters to defer their changes until the limits are reinstated.
   */
  private limitsSuspended = false;
  /**
   * Tilt/zoom limits captured by suspendLimits() and reinstated by
   * restoreLimits(). `null` whenever no reveal is holding the limits open.
   */
  private savedLimits:
    | { minPolarAngle: number; maxPolarAngle: number; minDistance: number; maxDistance: number }
    | null = null;
  /**
   * The closest approach the map ITSELF allows (defaults / `setZoomRange`),
   * kept apart from `controls.minDistance` so an overlay's zoom cap
   * (`setMaxZoomCap`) can sit on top of it and be lifted again without
   * either one forgetting the other.
   */
  private baseMinDistance = DEFAULT_MIN_DISTANCE;
  /** Overlay zoom cap as a distance; null = none. */
  private capDistance: number | null = null;
  /** Overlay tilt cap (polar angle, radians; null = none) and its ease from the current tilt. */
  private capPolar: number | null = null;
  private tiltCapEase: { from: number; startMs: number } | null = null;
  /** The map's own tilt range (polar radians), which the cap sits on top of. */
  private rangeMinPolar = 0;
  private rangeMaxPolar = 75 * DEG;
  /** A cap that arrived with the camera closer than it allows: the limit
   *  slides from where the camera was out to the cap, pushing it along. */
  private capEase: { from: number; startMs: number } | null = null;
  private readonly now: () => number;

  constructor(
    dom: HTMLCanvasElement,
    projection: Projection,
    init: CameraInitOptions,
    /** Injectable clock (ms) for the zoom-cap ease; default `performance.now`. */
    now: () => number = () => performance.now()
  ) {
    this.projection = projection;
    this.now = now;

    const aspect = dom.clientWidth / Math.max(1, dom.clientHeight);
    this.three = new THREE.PerspectiveCamera(50, aspect, 10, 60_000);

    // Place target at origin (camera anchored to projection origin).
    const distance = zoomToDistance(init.zoom);
    const tiltRad = THREE.MathUtils.clamp(init.tilt, 0, 75) * DEG;
    const bearingRad = init.bearing * DEG;
    // Polar angle from +Y axis (0 = top-down). MapControls uses spherical coords.
    this.three.position.set(
      distance * Math.sin(tiltRad) * Math.sin(bearingRad),
      distance * Math.cos(tiltRad),
      distance * Math.sin(tiltRad) * Math.cos(bearingRad)
    );
    this.three.lookAt(0, 0, 0);

    this.controls = new MapControls(this.three, dom);
    this.controls.enableDamping = true;
    // Lower damping factor = slower lerp toward the target spherical state, so
    // each wheel tick feels like a smooth animation rather than a snap.
    this.controls.dampingFactor = 0.05;
    this.controls.zoomSpeed = 1.5;
    // Zoom toward where the cursor is pointing rather than the camera target.
    // Combined with damping, this reads as a smooth scroll-into-the-map motion.
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = DEFAULT_MIN_DISTANCE;
    // Keep maxDistance comfortably less than the camera far plane so the target
    // itself never crosses the far clipping plane (which would make all nearby
    // buildings disappear at max zoom-out).
    this.controls.maxDistance = DEFAULT_MAX_DISTANCE;
    this.controls.maxPolarAngle = 75 * DEG;
    this.controls.minPolarAngle = 0;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => {
      this.onChange?.();
    });
    // MapControls dispatches `start`/`end` around every drag, pinch, and wheel
    // gesture. These are the proactive gesture signal the tile-priority gate
    // rides on — fired before the camera has even moved, so the first frame of
    // a fling is already build-free.
    this.controls.addEventListener('start', () => {
      this.gestureLive = true;
      this.onInteractionStart?.();
    });
    this.controls.addEventListener('end', () => {
      this.gestureLive = false;
      this.onInteractionEnd?.();
    });

    // MapControls reads panSpeed fresh on every move, so switching it on
    // pointerdown (by pointerType) applies cleanly to the gesture that
    // follows: touch swipes pan faster, mouse drags keep the desktop feel.
    this.dom = dom;
    this.controls.panSpeed = MapCameraController.MOUSE_PAN_SPEED;
    this.onPointerDown = (e: PointerEvent) => {
      this.controls.panSpeed = e.pointerType === 'touch'
        ? MapCameraController.TOUCH_PAN_SPEED
        : MapCameraController.MOUSE_PAN_SPEED;
    };
    dom.addEventListener('pointerdown', this.onPointerDown);
  }

  update(dt: number): void {
    if (this.capEase) this.applyMinDistance();
    if (this.tiltCapEase) this.applyPolarLimits();
    // Time-based inertia: the same decay per second whatever the frame rate (see BASE_DAMPING).
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_DAMPING_DT_S) : REF_FRAME_S;
    this.controls.dampingFactor = 1 - Math.pow(1 - BASE_DAMPING, step / REF_FRAME_S);
    this.controls.update();
    if (!this.gestureLive) this.endSubpixelGlide();
    if (this.bounds) this.clampTargetToBounds();
  }

  /**
   * End the inertia glide once its next step is under `GLIDE_STOP_PX` on screen. MapControls
   * damps per FRAME (5 % of the remaining delta each update) and only reports a change once the
   * drift since the last report passes a tiny epsilon, so after a drag the camera keeps creeping
   * for seconds — measured 0.35 CSS px a frame 0.3 s after release, still 0.02 px at 1.3 s, longer
   * at lower frame rates — and every one of those invisible steps is camera motion to the map:
   * the splat overlay stays on its lite motion LoD, dynamic resolution stays low, and the late,
   * sporadic steps flip detail blurry → sharp → blurry. Dropping the rest of the glide stops the
   * camera a few pixels short of where an invisible tail would have taken it.
   */
  /** A MapControls gesture (drag, pinch, wheel event) is in progress. */
  isGestureLive(): boolean {
    return this.gestureLive;
  }

  private endSubpixelGlide(): void {
    const c = this.controls as unknown as {
      _panOffset?: THREE.Vector3;
      _sphericalDelta?: THREE.Spherical;
      dampingFactor: number;
      enableDamping: boolean;
    };
    if (!c.enableDamping || !c._panOffset || !c._sphericalDelta) return;
    const pan = c._panOffset.length();
    const rot = Math.abs(c._sphericalDelta.theta) + Math.abs(c._sphericalDelta.phi);
    if (pan === 0 && rot === 0) return;
    const distance = Math.max(1e-6, this.three.position.distanceTo(this.controls.target));
    const focalPx = (this.dom.clientHeight || 1) / 2 / Math.tan((this.three.fov * DEG) / 2);
    // The step a REFERENCE frame would take, so the stop speed is the same at any frame rate.
    const stepPx = (pan / distance + rot) * BASE_DAMPING * focalPx;
    if (stepPx >= GLIDE_STOP_PX) return;
    c._panOffset.set(0, 0, 0);
    c._sphericalDelta.set(0, 0, 0);
  }

  /**
   * Restrict camera panning so the target's lat/lon stays inside the box.
   * Pass `null` to remove any active restriction.
   */
  setBounds(bounds: BoundingBox | null): void {
    this.bounds = bounds;
    if (bounds) this.clampTargetToBounds();
  }

  /**
   * Clamp the allowed tilt to `[min, max]` degrees, where 0 = top-down and
   * the camera physically can't go past 89°. Pass `null` to restore the
   * default (0–75°). Wires straight into MapControls' polar-angle clamping.
   */
  setTiltRange(range: { min: number; max: number } | null): void {
    let minPolar: number;
    let maxPolar: number;
    if (range === null) {
      minPolar = 0;
      maxPolar = 75 * DEG;
    } else {
      const min = Math.max(0, Math.min(89, range.min));
      const max = Math.max(min, Math.min(89, range.max));
      minPolar = min * DEG;
      maxPolar = max * DEG;
    }
    this.rangeMinPolar = minPolar;
    this.rangeMaxPolar = maxPolar;
    this.applyPolarLimits();
  }

  /**
   * Overlay tilt cap: hold the camera's tilt at or under `maxTiltDeg` ON TOP of the map's own
   * tilt range (whichever is tighter wins) until it is lifted with `null`, which puts the range
   * back exactly. A camera tilted further than the cap when it arrives is eased up to it over
   * `ZOOM_CAP_EASE_MS` rather than snapped. The splats overlay uses this with its zoom cap: the
   * satellite layer is at its best, and cheapest, seen from above rather than along the ground.
   */
  setMaxTiltCap(maxTiltDeg: number | null): void {
    const next = maxTiltDeg === null || !Number.isFinite(maxTiltDeg)
      ? null
      : Math.max(0, Math.min(89, maxTiltDeg)) * DEG;
    if (next === this.capPolar) return;
    this.capPolar = next;
    this.tiltCapEase = null;
    if (next !== null && !this.limitsSuspended) {
      const polar = this.controls.getPolarAngle();
      if (polar > next) this.tiltCapEase = { from: polar, startMs: this.now() };
    }
    this.applyPolarLimits();
    this.onChange?.();
  }

  /** The tilt cap in effect, degrees (`null` = none). */
  getMaxTiltCap(): number | null {
    return this.capPolar === null ? null : this.capPolar / DEG;
  }

  /** Write the effective tilt limits: the map's range, tightened by the overlay cap (mid-ease:
   *  wherever the sliding limit has got to). */
  private applyPolarLimits(): void {
    let maxPolar = this.rangeMaxPolar;
    if (this.capPolar !== null) {
      let cap = this.capPolar;
      if (this.tiltCapEase) {
        const t = Math.min(1, (this.now() - this.tiltCapEase.startMs) / ZOOM_CAP_EASE_MS);
        cap = this.tiltCapEase.from + (cap - this.tiltCapEase.from) * easeInOutCubic(t);
        if (t >= 1) this.tiltCapEase = null;
        // The limit moved but MapControls only reports the camera — keep frames coming.
        this.onChange?.();
      }
      maxPolar = Math.min(maxPolar, cap);
    }
    const minPolar = Math.min(this.rangeMinPolar, maxPolar);
    // While a floor-badge reveal has the limits lifted, record the new range
    // as what to reinstate on close instead of fighting the relaxed live
    // controls — so the floor view stays put even if a quality-tier switch
    // retunes the tilt range mid-reveal.
    if (this.limitsSuspended && this.savedLimits) {
      this.savedLimits.minPolarAngle = minPolar;
      this.savedLimits.maxPolarAngle = maxPolar;
      return;
    }
    this.controls.minPolarAngle = minPolar;
    this.controls.maxPolarAngle = maxPolar;
  }

  /**
   * Clamp the allowed bearing to `[min, max]` degrees from north (+CW). Pass
   * `null` to restore unconstrained 360° rotation. Wires into MapControls'
   * azimuth-angle clamping (its convention matches ours — atan2(x, z)).
   */
  setBearingRange(range: { min: number; max: number } | null): void {
    if (range === null) {
      this.controls.minAzimuthAngle = -Infinity;
      this.controls.maxAzimuthAngle = Infinity;
      return;
    }
    const min = Math.max(-180, Math.min(180, range.min));
    const max = Math.max(min, Math.min(180, range.max));
    this.controls.minAzimuthAngle = min * DEG;
    this.controls.maxAzimuthAngle = max * DEG;
  }

  /**
   * Clamp the allowed zoom to `[min, max]`. Pass `null` to restore the
   * defaults (~4–22). The MapControls API works in distance (closer = higher
   * zoom), so the bounds get inverted before writing — minDistance pairs
   * with maxZoom and vice versa.
   */
  setZoomRange(range: { min: number; max: number } | null): void {
    let minDist: number;
    let maxDist: number;
    if (range === null) {
      minDist = DEFAULT_MIN_DISTANCE;
      maxDist = DEFAULT_MAX_DISTANCE;
    } else {
      const min = Math.min(range.min, range.max);
      const max = Math.max(range.min, range.max);
      minDist = zoomToDistance(max);
      maxDist = zoomToDistance(min);
    }
    this.baseMinDistance = minDist;
    // Same deferral as setTiltRange while a floor-badge reveal is active.
    if (this.limitsSuspended && this.savedLimits) {
      this.savedLimits.maxDistance = maxDist;
    } else {
      this.controls.maxDistance = maxDist;
    }
    this.applyMinDistance();
  }

  /**
   * Overlay zoom cap: hold the camera's max zoom at `maxZoom` ON TOP of the
   * map's own zoom range (whichever is tighter wins) until it is lifted with
   * `null`, which puts the previous limit back exactly — `setZoomRange` calls
   * made meanwhile included. If the camera is closer than the cap allows when
   * it arrives, it is eased out over `ZOOM_CAP_EASE_MS` rather than snapped.
   * The splats overlay uses this: up close its surfels read as blobs.
   */
  setMaxZoomCap(maxZoom: number | null): void {
    const next = maxZoom === null || !Number.isFinite(maxZoom) ? null : zoomToDistance(maxZoom);
    if (next === this.capDistance) return;
    this.capDistance = next;
    this.capEase = null;
    if (next !== null && !this.limitsSuspended) {
      const distance = this.three.position.distanceTo(this.controls.target);
      if (distance < next) this.capEase = { from: distance, startMs: this.now() };
    }
    this.applyMinDistance();
    this.onChange?.();
  }

  /** The zoom cap in effect (`null` = none). */
  getMaxZoomCap(): number | null {
    return this.capDistance === null ? null : distanceToZoom(this.capDistance);
  }

  /** Write the effective closest approach: the map's own limit, or the
   *  overlay cap (mid-ease: wherever the sliding limit has got to). */
  private applyMinDistance(): void {
    let min = this.baseMinDistance;
    if (this.capDistance !== null) {
      let cap = this.capDistance;
      if (this.capEase) {
        const t = Math.min(1, (this.now() - this.capEase.startMs) / ZOOM_CAP_EASE_MS);
        cap = this.capEase.from + (cap - this.capEase.from) * easeInOutCubic(t);
        if (t >= 1) this.capEase = null;
        // The limit moved but MapControls only reports the camera — keep
        // frames coming until the ease has finished.
        this.onChange?.();
      }
      min = Math.max(min, cap);
    } else {
      this.capEase = null;
    }
    if (this.limitsSuspended && this.savedLimits) {
      // A floor-badge reveal holds the limits open: hand it the value to
      // reinstate instead of fighting the relaxed live controls.
      this.savedLimits.minDistance = Math.min(min, this.savedLimits.maxDistance);
      return;
    }
    // Never past the far limit (a cap looser than the map's MIN zoom).
    this.controls.minDistance = Math.min(min, this.controls.maxDistance);
  }

  /**
   * Floor-badge reveal: temporarily lift the tilt and zoom limits so the
   * camera can tilt down to / zoom in on a building floor even when the
   * developer (or a quality tier) clamped the range tighter than the floor
   * view needs. The active limits are captured for restoreLimits() to put
   * back exactly. Idempotent — a second call without an intervening restore
   * keeps the originally-saved limits (won't overwrite them with the
   * already-relaxed values).
   */
  suspendLimits(): void {
    if (this.limitsSuspended) return;
    this.limitsSuspended = true;
    this.savedLimits = {
      minPolarAngle: this.controls.minPolarAngle,
      maxPolarAngle: this.controls.maxPolarAngle,
      minDistance: this.controls.minDistance,
      maxDistance: this.controls.maxDistance
    };
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = 75 * DEG;
    this.controls.minDistance = DEFAULT_MIN_DISTANCE;
    this.controls.maxDistance = DEFAULT_MAX_DISTANCE;
  }

  /**
   * Reinstate the tilt/zoom limits captured by the last suspendLimits().
   * No-op if nothing is currently suspended. Call this only AFTER the camera
   * has settled back inside the original limits, or the first still-relaxed
   * frames get clamped into a visible jump.
   */
  restoreLimits(): void {
    if (!this.limitsSuspended || !this.savedLimits) return;
    this.controls.minPolarAngle = this.savedLimits.minPolarAngle;
    this.controls.maxPolarAngle = this.savedLimits.maxPolarAngle;
    this.controls.minDistance = this.savedLimits.minDistance;
    this.controls.maxDistance = this.savedLimits.maxDistance;
    this.savedLimits = null;
    this.limitsSuspended = false;
  }

  /**
   * After MapControls has updated this frame, snap the target back inside
   * the bounding box if the user panned past an edge. The camera is shifted
   * by the same delta so the relative offset (zoom + tilt + bearing) is
   * preserved; only the lat/lon focus changes.
   */
  private clampTargetToBounds(): void {
    if (!this.bounds) return;
    const target = this.controls.target;
    const ll = this.projection.unproject(target.x, -target.z);
    const lat = Math.max(this.bounds.south, Math.min(this.bounds.north, ll.lat));
    const lon = Math.max(this.bounds.west, Math.min(this.bounds.east, ll.lon));
    if (lat === ll.lat && lon === ll.lon) return;
    const m = this.projection.project(lon, lat);
    const dx = m.x - target.x;
    const dz = -m.y - target.z;
    this.controls.target.x += dx;
    this.controls.target.z += dz;
    this.three.position.x += dx;
    this.three.position.z += dz;
    this.onChange?.();
  }

  resize(width: number, height: number): void {
    this.three.aspect = width / Math.max(1, height);
    this.three.updateProjectionMatrix();
  }

  setView(lat: number, lon: number, zoom?: number): void {
    // The arguments are POSITIONAL, and an options object is the natural thing to reach for —
    // `setView({ lat, lon, zoom })` then projects `undefined`, which puts the camera at NaN and
    // leaves the map rendering nothing, with no error anywhere. Silent NaN is the worst outcome
    // available: say what was passed instead.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new TypeError(
        `setView(lat, lon, zoom?) takes POSITIONAL numbers — got lat=${describeArg(lat)}, ` +
          `lon=${describeArg(lon)}. If you meant to pass an object, use flyTo({ lat, lon, ... }).`
      );
    }
    if (zoom !== undefined && !Number.isFinite(zoom)) {
      throw new TypeError(`setView: zoom must be a finite number when given — got ${describeArg(zoom)}.`);
    }
    const m = this.projection.project(lon, lat);
    // Convention: Mercator X → scene X, Mercator Y → scene -Z (north is -Z).
    const targetX = m.x;
    const targetZ = -m.y;
    const distance = zoom !== undefined ? zoomToDistance(zoom) : this.three.position.distanceTo(this.controls.target);

    const dir = new THREE.Vector3().subVectors(this.three.position, this.controls.target).normalize();
    this.controls.target.set(targetX, 0, targetZ);
    this.three.position.copy(this.controls.target).addScaledVector(dir, distance);
    this.controls.update();
    this.onChange?.();
  }

  /**
   * Re-orient the camera by absolute tilt (deg from +Y, 0 = top-down) and
   * bearing (deg from north, +CW), preserving the current target and distance.
   * Either argument may be undefined to leave that axis unchanged.
   */
  setOrientation(tilt?: number, bearing?: number): void {
    const target = this.controls.target;
    const offset = new THREE.Vector3().subVectors(this.three.position, target);
    const radius = offset.length();
    const curTilt = Math.acos(THREE.MathUtils.clamp(offset.y / radius, -1, 1));
    const curBearing = Math.atan2(offset.x, offset.z);
    const nextTilt = tilt !== undefined
      ? THREE.MathUtils.clamp(tilt, 0, 75) * DEG
      : curTilt;
    const nextBearing = bearing !== undefined ? bearing * DEG : curBearing;
    this.three.position.set(
      target.x + radius * Math.sin(nextTilt) * Math.sin(nextBearing),
      target.y + radius * Math.cos(nextTilt),
      target.z + radius * Math.sin(nextTilt) * Math.cos(nextBearing)
    );
    this.three.lookAt(target);
    this.controls.update();
    this.onChange?.();
  }

  getView(): CameraView {
    const target = this.controls.target;
    const ll = this.projection.unproject(target.x, -target.z);
    const distance = this.three.position.distanceTo(target);
    const offset = new THREE.Vector3().subVectors(this.three.position, target);
    const radius = offset.length();
    const tilt = Math.acos(THREE.MathUtils.clamp(offset.y / radius, -1, 1)) * RAD;
    const bearing = Math.atan2(offset.x, offset.z) * RAD;
    return {
      lat: ll.lat,
      lon: ll.lon,
      zoom: distanceToZoom(distance),
      tilt,
      bearing
    };
  }

  async flyTo(opts: FlyToOptions): Promise<void> {
    const duration = opts.durationMs ?? 800;
    const start = performance.now();
    const startView = this.getView();
    const endLat = opts.lat;
    const endLon = opts.lon;
    const endZoom = opts.zoom ?? startView.zoom;
    const endTilt = opts.tilt !== undefined ? opts.tilt : startView.tilt;
    // Pick the shortest angular path for bearing so we never spin the long way.
    let bearingDelta = opts.bearing !== undefined ? opts.bearing - startView.bearing : 0;
    if (bearingDelta > 180) bearingDelta -= 360;
    if (bearingDelta < -180) bearingDelta += 360;

    return new Promise<void>((resolve) => {
      const step = (): void => {
        const t = Math.min(1, (performance.now() - start) / duration);
        const e = easeInOutCubic(t);
        const lat = startView.lat + (endLat - startView.lat) * e;
        const lon = startView.lon + (endLon - startView.lon) * e;
        const zoom = startView.zoom + (endZoom - startView.zoom) * e;
        this.setView(lat, lon, zoom);
        if (opts.tilt !== undefined || opts.bearing !== undefined) {
          const tilt = startView.tilt + (endTilt - startView.tilt) * e;
          const bearing = startView.bearing + bearingDelta * e;
          this.setOrientation(
            opts.tilt !== undefined ? tilt : undefined,
            opts.bearing !== undefined ? bearing : undefined
          );
        }
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.controls.dispose();
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
