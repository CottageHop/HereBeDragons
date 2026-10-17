import { describe, it, expect } from 'vitest';
import { Projection } from '../src/core/Projection.js';
import { MapCameraController, ZOOM_CAP_EASE_MS } from '../src/controls/MapCameraController.js';

/**
 * `setMaxZoomCap` — the overlay zoom cap the splats layer uses (`maxCameraZoom`):
 * laid over the map's own zoom range, eased in when the camera is too close,
 * and lifted back to exactly the previous limit.
 */

/** The little of a canvas MapControls touches (node has no DOM). */
function fakeCanvas(): HTMLCanvasElement {
  const noop = (): void => {};
  const root = { addEventListener: noop, removeEventListener: noop };
  return {
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    getRootNode: () => root,
    ownerDocument: root
  } as unknown as HTMLCanvasElement;
}

function make(zoom: number): { cam: MapCameraController; setTime: (ms: number) => void } {
  let now = 0;
  const cam = new MapCameraController(
    fakeCanvas(),
    new Projection(35.1222, -80.8237),
    { zoom, tilt: 45, bearing: 0 },
    () => now
  );
  // The map's RAF loop runs with damping; settle instantly for the test.
  cam.controls.enableDamping = false;
  return { cam, setTime: (ms) => { now = ms; } };
}

describe('MapCameraController.setMaxZoomCap', () => {
  it('stops zooming in at the cap, and the previous limit returns when it is lifted', () => {
    const { cam } = make(16);
    const before = cam.controls.minDistance;
    cam.setMaxZoomCap(17);
    expect(cam.getMaxZoomCap()).toBeCloseTo(17, 9);
    cam.setView(35.1222, -80.8237, 19); // programmatic zoom-in past the cap
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(17, 6);

    cam.setMaxZoomCap(null);
    expect(cam.getMaxZoomCap()).toBeNull();
    expect(cam.controls.minDistance).toBe(before);
    cam.setView(35.1222, -80.8237, 19);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(19, 6);
  });

  it('eases a camera that is already closer out to the cap instead of snapping', () => {
    const { cam, setTime } = make(18.5);
    cam.setMaxZoomCap(17);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(18.5, 6); // t = 0: nothing has moved yet

    let last = 18.5;
    for (const t of [0.25, 0.5, 0.75]) {
      setTime(ZOOM_CAP_EASE_MS * t);
      cam.update(0);
      const z = cam.getView().zoom;
      expect(z).toBeLessThan(last);
      expect(z).toBeGreaterThan(17);
      last = z;
    }
    setTime(ZOOM_CAP_EASE_MS);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(17, 6);
    // Settled: the hard limit is the cap itself from here on.
    setTime(ZOOM_CAP_EASE_MS * 5);
    cam.setView(35.1222, -80.8237, 20);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(17, 6);
  });

  it('a camera already further out than the cap is left alone', () => {
    const { cam } = make(15);
    cam.setMaxZoomCap(17);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(15, 6);
  });

  it('composes with setZoomRange: the tighter limit wins, and lifting the cap restores the RANGE set meanwhile', () => {
    const { cam } = make(15);
    cam.setZoomRange({ min: 12, max: 16 }); // the map is tighter than the cap
    cam.setMaxZoomCap(17);
    cam.setView(35.1222, -80.8237, 19);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(16, 6);

    cam.setZoomRange({ min: 12, max: 20 }); // changed while the cap is held
    cam.setView(35.1222, -80.8237, 19);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(17, 6); // now the cap is the tighter one

    cam.setMaxZoomCap(null);
    cam.setView(35.1222, -80.8237, 19);
    cam.update(0);
    expect(cam.getView().zoom).toBeCloseTo(19, 6); // …and the new range is what came back
    cam.setZoomRange(null);
    expect(cam.controls.minDistance).toBe(25);
  });

  it('survives a floor-badge reveal: the suspended limits are reinstated WITH the cap', () => {
    const { cam } = make(16);
    cam.setMaxZoomCap(17);
    const capped = cam.controls.minDistance;
    cam.suspendLimits();
    expect(cam.controls.minDistance).toBe(25); // the reveal may go closer
    cam.restoreLimits();
    expect(cam.controls.minDistance).toBe(capped);
    // Lifted during a reveal → the reveal restores the UNcapped limit.
    cam.suspendLimits();
    cam.setMaxZoomCap(null);
    cam.restoreLimits();
    expect(cam.controls.minDistance).toBe(25);
  });
});

describe('MapCameraController.setMaxTiltCap', () => {
  const DEG = Math.PI / 180;
  const polar = (cam: MapCameraController): number => cam.controls.getPolarAngle() / DEG;
  /** A controller starting at `tilt` degrees, with a settable clock. */
  const makeTilted = (tilt: number): { cam: MapCameraController; setTime: (ms: number) => void } => {
    let now = 0;
    const cam = new MapCameraController(fakeCanvas(), new Projection(35.1222, -80.8237), { zoom: 16, tilt, bearing: 0 }, () => now);
    cam.controls.enableDamping = false;
    cam.update(0);
    return { cam, setTime: (ms) => { now = ms; } };
  };

  it('lays a tilt cap over the map range, eases a steeper camera up to it, and lifts exactly', () => {
    const { cam, setTime } = makeTilted(62);
    cam.setTiltRange({ min: 0, max: 70 });
    expect(polar(cam)).toBeCloseTo(62, 5);
    expect(cam.getMaxTiltCap()).toBeNull();
    cam.setMaxTiltCap(45);
    expect(cam.getMaxTiltCap()).toBe(45);
    // the limit slides from 62 towards 45 over ZOOM_CAP_EASE_MS: not a snap
    setTime(ZOOM_CAP_EASE_MS * 0.5);
    cam.update(1 / 60);
    expect(polar(cam)).toBeLessThan(62);
    expect(polar(cam)).toBeGreaterThan(45);
    setTime(ZOOM_CAP_EASE_MS + 1);
    cam.update(1 / 60);
    expect(polar(cam)).toBeCloseTo(45, 5);
    expect(cam.controls.maxPolarAngle).toBeCloseTo(45 * DEG, 9);
    // the map's own range still applies underneath, and a tighter range wins
    cam.setTiltRange({ min: 0, max: 40 });
    expect(cam.controls.maxPolarAngle).toBeCloseTo(40 * DEG, 9);
    cam.setTiltRange({ min: 0, max: 70 });
    expect(cam.controls.maxPolarAngle).toBeCloseTo(45 * DEG, 9);
    // lifted: the range comes back exactly
    cam.setMaxTiltCap(null);
    expect(cam.getMaxTiltCap()).toBeNull();
    expect(cam.controls.maxPolarAngle).toBeCloseTo(70 * DEG, 9);
  });

  it('a camera already within the cap is left alone', () => {
    const { cam } = makeTilted(30);
    cam.setMaxTiltCap(45);
    cam.update(1 / 60);
    expect(polar(cam)).toBeCloseTo(30, 5);
  });
});
