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

function zoomToDistance(zoom: number): number {
  return ZOOM_BASE_DISTANCE * 2 ** -zoom;
}

function distanceToZoom(distance: number): number {
  return Math.log2(ZOOM_BASE_DISTANCE / distance);
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export class MapCameraController {
  /** Pan speed for mouse drag (desktop) — three.js MapControls default. */
  private static readonly MOUSE_PAN_SPEED = 1.0;
  /**
   * Pan speed for touch/swipe (phones). MapControls uses one panSpeed for all
   * input, and a finger swipe panned noticeably slower than a mouse drag felt
   * right, so touch gets a bump while the mouse stays at the desktop default.
   */
  private static readonly TOUCH_PAN_SPEED = 1.5;

  readonly three: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  onChange?: () => void;

  private projection: Projection;
  private bounds: BoundingBox | null = null;
  private dom: HTMLCanvasElement;
  private onPointerDown: (e: PointerEvent) => void;

  constructor(dom: HTMLCanvasElement, projection: Projection, init: CameraInitOptions) {
    this.projection = projection;

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
    this.controls.minDistance = 25;
    // Keep maxDistance comfortably less than the camera far plane so the target
    // itself never crosses the far clipping plane (which would make all nearby
    // buildings disappear at max zoom-out).
    this.controls.maxDistance = 30_000;
    this.controls.maxPolarAngle = 75 * DEG;
    this.controls.minPolarAngle = 0;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => {
      this.onChange?.();
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

  update(_dt: number): void {
    this.controls.update();
    if (this.bounds) this.clampTargetToBounds();
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
    if (range === null) {
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = 75 * DEG;
      return;
    }
    const min = Math.max(0, Math.min(89, range.min));
    const max = Math.max(min, Math.min(89, range.max));
    this.controls.minPolarAngle = min * DEG;
    this.controls.maxPolarAngle = max * DEG;
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
    if (range === null) {
      this.controls.minDistance = 25;
      this.controls.maxDistance = 30_000;
      return;
    }
    const min = Math.min(range.min, range.max);
    const max = Math.max(range.min, range.max);
    this.controls.minDistance = zoomToDistance(max);
    this.controls.maxDistance = zoomToDistance(min);
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
