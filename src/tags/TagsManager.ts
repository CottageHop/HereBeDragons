import * as THREE from 'three';
import type { Projection } from '../core/Projection.js';
import type { MapCameraController } from '../controls/MapCameraController.js';
import type { Renderer } from '../rendering/Renderer.js';
import { injectDefaultStylesOnce } from './defaultStyles.js';
import type {
  ClusterOptions,
  TagHandle,
  TagOptions,
  TagsConfig
} from './types.js';

/** Internal state for a registered tag. */
interface TagEntry {
  options: TagOptions;
  element: HTMLElement;
  /** Latest projected screen position (px). NaN if not yet projected. */
  screenX: number;
  screenY: number;
  /** True if the projected position fell inside the viewport (after camera projection). */
  inView: boolean;
  /** Handle returned to the developer — kept stable across the tag's lifetime. */
  handle: TagHandle;
  /**
   * Cached resolver result. `undefined` = needs recomputing (set on add and
   * when invalidateAutoElevations() is called); a number = use that Y; null =
   * the resolver said "no auto, fall back to ground".
   */
  cachedAutoElevation: number | null | undefined;
  /**
   * Cached rendered size in CSS pixels. -1 means "not yet measured" — the
   * hit-test lazily fills these on first sight, and `handle.setText` /
   * `removeTag` paths reset them when content changes. Avoids a
   * getBoundingClientRect call per tag on every pointermove.
   */
  cachedWidth: number;
  cachedHeight: number;
}

/** Hard-coded cluster diameter — matches the `.hbd-cluster` rule in defaultStyles. */
const CLUSTER_SIZE = 40;

/**
 * Backing storage for the cluster element's "member tag ids". Originally
 * stashed on `el.dataset.tagIds` as a comma-joined string and re-parsed on
 * every pointermove hit-test. Storing as a plain array on the element via a
 * WeakMap avoids per-pointermove splitting + filtering.
 */
const CLUSTER_IDS = new WeakMap<HTMLElement, string[]>();

/** Internal record describing a cluster of tag entries. */
interface ClusterRecord {
  /** Member entry IDs. */
  ids: string[];
  /** Cluster center in screen pixels. */
  centerX: number;
  centerY: number;
}

const DEFAULT_MERGE_DISTANCE = 60;

export interface TagsManagerDeps {
  /** Container element (the same one passed to createHereBeDragons). */
  container: HTMLElement;
  renderer: Renderer;
  camera: MapCameraController;
  projection: Projection;
  /**
   * Called when a tag opens its modal. HereBeDragons wires this to
   * BuildingsManager so a tag's `buildingId`/`floor` highlights the
   * associated building. Pass `null` to clear any active highlight.
   */
  onBuildingHighlight?: (buildingId: string | null, floor?: number) => void;
  /**
   * Resolve the auto-elevation for a tag at the given geographic position.
   * Return a number (world meters) to anchor the tag at that height
   * (typically the roof of an underlying building); return null to leave the
   * tag at ground level. Used so badges floating over tall buildings sit on
   * top of them by default, but drop back to street level when the buildings
   * layer is disabled. Skipped when the tag passed an explicit `elevation`.
   */
  resolveAutoElevation?: (lon: number, lat: number) => number | null;
  /**
   * Called when a tag with `floor !== undefined` opens its modal. HereBeDragons
   * wires this to the camera controller so a floor-specific badge centers,
   * zooms in, and tilts the camera down to better reveal the building's
   * vertical structure. Receives the tag's coords + floor + the badge's
   * world-meter elevation above the ground — the host uses elevation to
   * vertically center the camera on the badge rather than the ground point
   * directly below it.
   */
  onFloorBadgeOpen?: (
    info: { lat: number; lon: number; floor: number; elevation: number }
  ) => void;
  /**
   * Called when a floor-tagged modal closes (or is swapped out for another).
   * The HereBeDragons implementation restores the full camera view (lat /
   * lon / zoom / tilt / bearing) to what it was before `onFloorBadgeOpen`.
   */
  onFloorBadgeClose?: () => void;
}

/**
 * Manages a DOM overlay of interactive tag widgets positioned over the map.
 *
 * Each frame:
 *   1. Project every tag's (lat, lon) through the projection + camera into
 *      screen pixels.
 *   2. Cluster tags whose projected positions fall within `mergeDistancePx`.
 *   3. Show one DOM element per output: either the tag's own widget (cluster
 *      of 1) or a generic cluster bubble with the count (cluster of N).
 *   4. If a modal is open, reposition it above its anchor tag (or hide if
 *      that tag became clustered / off-screen).
 *
 * Cluster of 1 → tag is clickable, opens its modal.
 * Cluster of 2+ → click zooms the camera in toward the cluster centroid.
 */
export class TagsManager {
  private readonly container: HTMLElement;
  private readonly overlay: HTMLDivElement;
  private readonly camera: MapCameraController;
  private readonly renderer: Renderer;
  private readonly projection: Projection;
  private readonly onBuildingHighlight?: TagsManagerDeps['onBuildingHighlight'];
  private readonly resolveAutoElevation?: TagsManagerDeps['resolveAutoElevation'];
  private readonly onFloorBadgeOpen?: TagsManagerDeps['onFloorBadgeOpen'];
  private readonly onFloorBadgeClose?: TagsManagerDeps['onFloorBadgeClose'];

  private readonly tags = new Map<string, TagEntry>();
  /** Pool of cluster DOM elements — reused frame-to-frame to avoid churn. */
  private readonly clusterPool: HTMLDivElement[] = [];
  /** Number of cluster elements actively visible this frame. */
  private activeClusterCount = 0;

  private modal: HTMLDivElement;
  private modalTitle: HTMLHeadingElement;
  private modalBody: HTMLDivElement;
  private modalCustomMounted: HTMLElement | null = null;
  private openTagId: string | null = null;
  /**
   * While true, the per-frame auto-close check (anchor tag drifted off-screen
   * or got clustered) is suppressed. Manual closes (close button, click
   * outside) still work. HereBeDragons sets this true around its floor-badge
   * fly-to so intermediate animation frames — which can briefly project the
   * badge out of frustum or re-cluster it — don't trigger a spurious close.
   */
  private modalAutoCloseSuppressed = false;

  private clusterConfig: Required<Omit<ClusterOptions, 'onClick'>> & {
    onClick: ClusterOptions['onClick'];
  };

  // Reusable scratch buffers.
  private projector = new THREE.Vector3();
  /**
   * Scratch buffer for the per-frame "sort tags by priority" step in
   * `cluster()`. Resized only when the visible-tag count grows; otherwise
   * the same array slots are reused frame-to-frame. Avoids the per-frame
   * `visible.slice()` allocation.
   */
  private sortScratch: TagEntry[] = [];

  constructor(deps: TagsManagerDeps, config: TagsConfig = {}) {
    this.container = deps.container;
    this.camera = deps.camera;
    this.renderer = deps.renderer;
    this.projection = deps.projection;
    this.onBuildingHighlight = deps.onBuildingHighlight;
    this.resolveAutoElevation = deps.resolveAutoElevation;
    this.onFloorBadgeOpen = deps.onFloorBadgeOpen;
    this.onFloorBadgeClose = deps.onFloorBadgeClose;

    if (config.injectDefaultStyles !== false) injectDefaultStylesOnce();

    this.clusterConfig = {
      mergeDistancePx: config.cluster?.mergeDistancePx ?? DEFAULT_MERGE_DISTANCE,
      color: config.cluster?.color ?? '#3b82f6',
      onClick: config.cluster?.onClick
    };

    // The overlay sits inside the same container as the canvas, absolutely
    // positioned, transparent. pointer-events: none lets the canvas catch
    // map controls; individual tags/clusters/modal opt back into `auto`.
    this.overlay = document.createElement('div');
    this.overlay.className = 'hbd-tags-overlay';
    this.container.appendChild(this.overlay);

    // Wheel events on a tag/modal don't bubble sideways to the canvas, so
    // MapControls never sees them. Catch them at the overlay (tags + modal
    // bubble through here) and re-fire on the canvas so the user can zoom
    // even with the cursor parked over a badge.
    this.overlay.addEventListener('wheel', this.onOverlayWheel, { passive: false });

    // One shared modal element — only one tag's modal can be open at a time.
    this.modal = document.createElement('div');
    this.modal.className = 'hbd-modal';
    this.modal.hidden = true;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'hbd-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×'; // ×
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeModal();
    });
    this.modalTitle = document.createElement('h3');
    this.modalTitle.className = 'hbd-modal-title';
    this.modalBody = document.createElement('div');
    this.modalBody.className = 'hbd-modal-body';
    this.modal.appendChild(closeBtn);
    this.modal.appendChild(this.modalTitle);
    this.modal.appendChild(this.modalBody);
    this.overlay.appendChild(this.modal);

    // Click detection: badges are pointer-events:none so pointer events fall
    // through to the canvas. We listen on document with capture:true so the
    // hit-test runs BEFORE the event ever reaches MapControls' listeners on
    // the canvas — that way pressing on a badge can short-circuit and
    // MapControls never starts a pan in the first place.
    document.addEventListener('pointerdown', this.onDocPointerDownCapture, { capture: true });
    document.addEventListener('pointerup', this.onDocPointerUpCapture, { capture: true });
    // Cursor feedback — badges are pointer-events:none so the browser can't
    // change the cursor for us. Hit-test on move and toggle pointer/grab.
    document.addEventListener('pointermove', this.onDocPointerMoveCapture, { capture: true });
    document.addEventListener('keydown', this.onDocKeyDown);
  }

  // -------------------------------------------------------------------------
  // Public API (called via HereBeDragons forwarding methods)
  // -------------------------------------------------------------------------

  addTag(options: TagOptions): TagHandle {
    if (this.tags.has(options.id)) {
      this.removeTag(options.id);
    }
    const element = options.element ?? this.buildDefaultTagElement(options);
    // Click handling is delegated to a canvas-level pointerdown/up hit-test
    // so drags/wheel pass through to the map — see onCanvasPointerUp.
    this.overlay.appendChild(element);

    const entry: TagEntry = {
      options,
      element,
      screenX: NaN,
      screenY: NaN,
      inView: false,
      handle: this.makeHandle(options.id),
      cachedAutoElevation: undefined,
      cachedWidth: -1,
      cachedHeight: -1
    };
    this.tags.set(options.id, entry);
    return entry.handle;
  }

  removeTag(id: string): void {
    const entry = this.tags.get(id);
    if (!entry) return;
    entry.element.remove();
    this.tags.delete(id);
    if (this.openTagId === id) this.closeModal();
  }

  clearTags(): void {
    for (const id of this.tags.keys()) this.removeTag(id);
  }

  getTag(id: string): TagHandle | undefined {
    return this.tags.get(id)?.handle;
  }

  /** Iterate over registered tag handles. */
  *handles(): IterableIterator<TagHandle> {
    for (const entry of this.tags.values()) yield entry.handle;
  }

  /** Per-frame: project all tags, cluster, update DOM positions/visibility. */
  update(): void {
    if (this.tags.size === 0) {
      this.activeClusterCount = 0;
      this.hideUnusedClusters();
      this.updateModalPosition();
      return;
    }

    const cam = this.camera.three;
    const width = this.renderer.width;
    const height = this.renderer.height;

    // 1) Project every tag into screen space.
    const visible: TagEntry[] = [];
    for (const entry of this.tags.values()) {
      const m = this.projection.project(entry.options.lon, entry.options.lat);
      // Resolve the tag's Y. Order of precedence:
      //   1. Developer-specified options.elevation (e.g. floor-pinned tags).
      //   2. Cached auto-elevation from the resolver (typically the roof of
      //      an underlying building) — recomputed lazily on first sight
      //      and after invalidateAutoElevations() is called.
      //   3. Ground level (0).
      let elevation = entry.options.elevation;
      if (elevation === undefined) {
        if (entry.cachedAutoElevation === undefined && this.resolveAutoElevation) {
          entry.cachedAutoElevation = this.resolveAutoElevation(
            entry.options.lon,
            entry.options.lat
          );
        }
        elevation = entry.cachedAutoElevation ?? 0;
      }
      // Scene convention: world Z = -mercatorY.
      this.projector.set(m.x, elevation, -m.y).project(cam);
      const inFront = this.projector.z >= -1 && this.projector.z <= 1;
      entry.inView = inFront;
      if (!inFront) {
        entry.element.hidden = true;
        continue;
      }
      entry.screenX = (this.projector.x * 0.5 + 0.5) * width;
      entry.screenY = (1 - (this.projector.y * 0.5 + 0.5)) * height;
      visible.push(entry);
    }

    // 2) Greedy clustering on screen-space distance.
    const clusters = this.cluster(visible);

    // 3) Render: for each cluster, either show its single tag or a cluster
    //    bubble. Anything not part of a singleton cluster gets hidden.
    this.activeClusterCount = 0;
    const shownTagIds = new Set<string>();
    for (const c of clusters) {
      if (c.ids.length === 1) {
        const entry = this.tags.get(c.ids[0])!;
        entry.element.hidden = false;
        // Use the separate `translate` CSS property (independent of the base
        // `transform: translate(-50%, calc(-100% - 6px))` that centers the
        // element on its anchor). Avoids per-frame string concatenation.
        entry.element.style.translate = `${c.centerX.toFixed(1)}px ${c.centerY.toFixed(1)}px`;
        shownTagIds.add(entry.options.id);
      } else {
        const el = this.getOrCreateClusterEl();
        // The count lives in a dedicated child span with pointer-events:none
        // so clicks on the digit pass through to the cluster element instead
        // of starting a text drag-selection that cancels the click. Reuse the
        // existing span across frames to avoid DOM churn.
        let countEl = el.firstElementChild as HTMLSpanElement | null;
        if (!countEl || countEl.className !== 'hbd-cluster-count') {
          countEl = document.createElement('span');
          countEl.className = 'hbd-cluster-count';
          el.replaceChildren(countEl);
        }
        countEl.textContent = String(c.ids.length);
        el.hidden = false;
        el.style.translate = `${c.centerX.toFixed(1)}px ${c.centerY.toFixed(1)}px`;
        // Hand the member-id array directly to the element. Cluster records
        // are throwaway per frame, so the reference will be GC'd when the
        // next frame replaces it. JS is single-threaded → no race with
        // pointer hit-tests.
        CLUSTER_IDS.set(el, c.ids);
        // Hide the constituent tag elements.
        for (const id of c.ids) {
          const entry = this.tags.get(id);
          if (entry) entry.element.hidden = true;
        }
      }
    }

    // Visible-but-not-shown means hidden by clustering — already hidden above.
    // Tags that fell off-screen (entry.inView=false) were hidden in step 1.
    // No further work needed for non-visible tags.

    this.hideUnusedClusters();

    // 4) Modal follow-up: if the anchored tag became clustered or off-screen,
    //    close the modal; otherwise reposition. While `modalAutoCloseSuppressed`
    //    is set (typically during a camera fly-to that's heading TOWARD the
    //    badge), skip the auto-close so the modal survives intermediate
    //    animation frames where the badge may project out of frustum.
    if (this.openTagId) {
      const entry = this.tags.get(this.openTagId);
      if (!entry) {
        // Tag removed entirely — always close, suppression doesn't apply.
        this.closeModal();
      } else if (this.modalAutoCloseSuppressed) {
        if (entry.inView && shownTagIds.has(this.openTagId)) {
          this.updateModalPosition();
        }
        // else: badge transiently not visible; modal stays open, will
        // reposition on the next frame it IS visible.
      } else if (!entry.inView || !shownTagIds.has(this.openTagId)) {
        this.closeModal();
      } else {
        this.updateModalPosition();
      }
    }
  }

  /**
   * Toggle the per-frame "anchor tag drifted out of view → close modal" check.
   * Used by HereBeDragons to keep the modal open across the duration of a
   * floor-badge fly-to (intermediate animation frames can briefly fall
   * outside the visibility predicate). Manual close paths (close-button,
   * click-outside, switching to another tag) are unaffected.
   */
  setModalAutoCloseSuppressed(suppressed: boolean): void {
    this.modalAutoCloseSuppressed = suppressed;
  }

  /**
   * Drop all cached auto-elevations so they're recomputed on the next frame.
   * HereBeDragons calls this on tile load (new buildings may now sit under a
   * tag) and on the buildings layer toggling on/off.
   */
  invalidateAutoElevations(): void {
    for (const entry of this.tags.values()) {
      entry.cachedAutoElevation = undefined;
    }
  }

  dispose(): void {
    document.removeEventListener(
      'pointerdown',
      this.onDocPointerDownCapture,
      { capture: true } as EventListenerOptions
    );
    document.removeEventListener(
      'pointerup',
      this.onDocPointerUpCapture,
      { capture: true } as EventListenerOptions
    );
    document.removeEventListener(
      'pointermove',
      this.onDocPointerMoveCapture,
      { capture: true } as EventListenerOptions
    );
    document.removeEventListener('keydown', this.onDocKeyDown);
    this.overlay.removeEventListener('wheel', this.onOverlayWheel);
    this.clearTags();
    this.overlay.remove();
    for (const el of this.clusterPool) el.remove();
    this.clusterPool.length = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Greedy distance-based clustering. Sort by priority (higher first) so the
   * highest-priority tag in a region "wins" — it becomes the cluster seed.
   * For each remaining tag, attach it to the first existing cluster whose
   * center is within mergeDistancePx; otherwise start a new singleton cluster.
   */
  private cluster(visible: TagEntry[]): ClusterRecord[] {
    // Fill the reusable sort buffer instead of allocating a fresh array.
    const sorted = this.sortScratch;
    sorted.length = visible.length;
    for (let i = 0; i < visible.length; i++) sorted[i] = visible[i];
    sorted.sort(
      (a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0)
    );
    const md = this.clusterConfig.mergeDistancePx;
    const mdSq = md * md;
    const clusters: ClusterRecord[] = [];

    for (const entry of sorted) {
      let merged = false;
      for (const c of clusters) {
        const dx = entry.screenX - c.centerX;
        const dy = entry.screenY - c.centerY;
        if (dx * dx + dy * dy <= mdSq) {
          c.ids.push(entry.options.id);
          // Keep the cluster center at the seed (highest-priority) tag so the
          // cluster doesn't drift as more members join.
          merged = true;
          break;
        }
      }
      if (!merged) {
        clusters.push({
          ids: [entry.options.id],
          centerX: entry.screenX,
          centerY: entry.screenY
        });
      }
    }
    return clusters;
  }

  private getOrCreateClusterEl(): HTMLDivElement {
    if (this.activeClusterCount < this.clusterPool.length) {
      const el = this.clusterPool[this.activeClusterCount++];
      return el;
    }
    const el = document.createElement('div');
    el.className = 'hbd-cluster';
    el.style.background = this.clusterConfig.color;
    // Click handling is delegated — see onCanvasPointerUp's hit-test.
    this.overlay.appendChild(el);
    this.clusterPool.push(el);
    this.activeClusterCount++;
    return el;
  }

  private hideUnusedClusters(): void {
    for (let i = this.activeClusterCount; i < this.clusterPool.length; i++) {
      this.clusterPool[i].hidden = true;
    }
  }

  /** Camera fly-to the cluster's centroid at slightly closer zoom. */
  private async zoomToCluster(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    let lat = 0;
    let lon = 0;
    let n = 0;
    for (const id of ids) {
      const entry = this.tags.get(id);
      if (!entry) continue;
      lat += entry.options.lat;
      lon += entry.options.lon;
      n++;
    }
    if (n === 0) return;
    const view = this.camera.getView();
    await this.camera.flyTo({
      lat: lat / n,
      lon: lon / n,
      zoom: Math.min(view.zoom + 2, 18),
      durationMs: 600
    });
  }

  private openTag(id: string): void {
    const entry = this.tags.get(id);
    if (!entry) return;
    // If we're switching from one tag's modal directly to another's, fire
    // the "close" hook for the previous tag if it was a floor badge — the
    // visible modal is being replaced without an explicit close click, so
    // the camera-restore callback otherwise wouldn't fire and the camera
    // would stay tilted forever.
    if (this.openTagId && this.openTagId !== id) {
      const prev = this.tags.get(this.openTagId);
      if (prev?.options.floor !== undefined) this.onFloorBadgeClose?.();
    }
    this.openTagId = id;

    // Replace any previously mounted custom modal element.
    if (this.modalCustomMounted) {
      this.modal.removeChild(this.modalCustomMounted);
      this.modalCustomMounted = null;
      // Re-mount default children if they were detached.
      if (!this.modal.contains(this.modalTitle)) this.modal.appendChild(this.modalTitle);
      if (!this.modal.contains(this.modalBody)) this.modal.appendChild(this.modalBody);
    }

    if (entry.options.modalElement) {
      // Detach defaults, mount custom.
      if (this.modal.contains(this.modalTitle)) this.modal.removeChild(this.modalTitle);
      if (this.modal.contains(this.modalBody)) this.modal.removeChild(this.modalBody);
      this.modal.appendChild(entry.options.modalElement);
      this.modalCustomMounted = entry.options.modalElement;
    } else {
      const m = entry.options.modal ?? {};
      this.modalTitle.textContent = m.title ?? entry.options.text ?? '';
      this.modalTitle.hidden = !this.modalTitle.textContent;
      this.modalBody.innerHTML = m.body ?? '';
      this.modal.className = 'hbd-modal' + (m.className ? ' ' + m.className : '');
    }

    this.modal.hidden = false;
    this.updateModalPosition();

    // Notify the building-highlight system if this tag is anchored to a
    // building. The handler is wired by HereBeDragons → BuildingsManager.
    if (this.onBuildingHighlight && entry.options.buildingId) {
      this.onBuildingHighlight(entry.options.buildingId, entry.options.floor);
    }
    // Floor-tagged badge: ask the host to center + zoom + tilt the camera
    // so the building's vertical structure (highlighted floor band) is
    // actually visible. HereBeDragons saves the full view and restores it
    // on close.
    //
    // The badge's EFFECTIVE elevation (the Y the badge is actually drawn
    // at) is the same priority chain the per-frame projection uses:
    //   1. explicit `options.elevation` (e.g. floor mid-Y)
    //   2. previously-resolved auto-elevation (building top)
    //   3. resolve auto NOW if neither is set (first-click-before-render)
    //   4. ground (0)
    // Passing 0 here would skip the `H × tan(tilt)` offset and the camera
    // would land at the badge's GROUND point — a noticeable overshoot for
    // badges actually drawn high on a tall building.
    if (entry.options.floor !== undefined) {
      let elevation: number;
      if (entry.options.elevation !== undefined) {
        elevation = entry.options.elevation;
      } else {
        let cached = entry.cachedAutoElevation;
        if (cached === undefined && this.resolveAutoElevation) {
          cached = this.resolveAutoElevation(entry.options.lon, entry.options.lat);
          entry.cachedAutoElevation = cached;
        }
        elevation = cached ?? 0;
      }
      this.onFloorBadgeOpen?.({
        lat: entry.options.lat,
        lon: entry.options.lon,
        floor: entry.options.floor,
        elevation
      });
    }
  }

  private closeModal(): void {
    // Capture the closing tag's options BEFORE clearing openTagId, so the
    // floor-badge close hook fires with the right context.
    const closingId = this.openTagId;
    const closingEntry = closingId ? this.tags.get(closingId) : null;
    const wasFloorBadge = closingEntry?.options.floor !== undefined;
    this.openTagId = null;
    this.modal.hidden = true;
    this.onBuildingHighlight?.(null);
    if (wasFloorBadge) this.onFloorBadgeClose?.();
  }

  private updateModalPosition(): void {
    if (!this.openTagId) return;
    const entry = this.tags.get(this.openTagId);
    if (!entry || !entry.inView) return;
    // Measure the tag's rendered height so the modal sits cleanly above it.
    // The tag itself is offset 6px above its anchor (screenY); add the tag's
    // height plus a 6px gap above to land the modal's bottom clear of the tag.
    // Cache the height on the entry so repeated frames don't re-measure.
    if (entry.cachedHeight <= 0) {
      entry.cachedHeight = entry.element.offsetHeight || 28;
    }
    const offset = entry.cachedHeight + 12;
    // Modal's CSS pins it via `transform: translate(-50%, -100%)`. The
    // anchor's per-frame Y offset (tag height + gap) is baked into the
    // translate Y so the `transform` itself never changes.
    this.modal.style.translate =
      `${entry.screenX.toFixed(1)}px ${(entry.screenY - offset).toFixed(1)}px`;
  }

  /** Forward wheel events on the overlay (tags, modal) down to the canvas
   *  so MapControls can still zoom when the cursor is parked on a badge. */
  private onOverlayWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const canvas = this.renderer.dom;
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaZ: e.deltaZ,
      deltaMode: e.deltaMode,
      clientX: e.clientX,
      clientY: e.clientY,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      bubbles: true,
      cancelable: true
    }));
  };

  // Document-capture pointer tracking. If pointerdown hits a badge, we
  // "claim" the pointer — stopping propagation so MapControls never starts
  // its pan tracking. The claim is released on the matching pointerup and
  // a hit-test fires the badge's click action if it was a real click.
  private pointerStartX = 0;
  private pointerStartY = 0;
  private pointerStartTime = 0;
  private claimedPointerId = -1;
  private static CLICK_PX_THRESHOLD = 5;
  private static CLICK_MS_THRESHOLD = 500;

  private onDocPointerDownCapture = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // Only react to events that would land on the map canvas — otherwise
    // we'd be hit-testing pointer events on the studio panel, popups, etc.
    if (e.target !== this.renderer.dom) return;
    const hit = this.findHitAt(e.clientX, e.clientY);
    if (!hit) return;
    // Swallow it — MapControls' canvas listener (further down the
    // propagation path) never sees this pointerdown, so no pan starts.
    e.stopImmediatePropagation();
    this.pointerStartX = e.clientX;
    this.pointerStartY = e.clientY;
    this.pointerStartTime = performance.now();
    this.claimedPointerId = e.pointerId;
  };

  private onDocPointerMoveCapture = (e: PointerEvent): void => {
    if (e.target !== this.renderer.dom) return;
    // Don't fight the renderer's drag cursor while a button is held.
    if (e.buttons > 0) return;
    const canvas = this.renderer.dom;
    canvas.style.cursor = this.findHitAt(e.clientX, e.clientY) ? 'pointer' : 'grab';
  };

  private onDocPointerUpCapture = (e: PointerEvent): void => {
    if (e.pointerId !== this.claimedPointerId) return;
    e.stopImmediatePropagation();
    this.claimedPointerId = -1;
    const dx = e.clientX - this.pointerStartX;
    const dy = e.clientY - this.pointerStartY;
    if (Math.hypot(dx, dy) > TagsManager.CLICK_PX_THRESHOLD) return;
    if (performance.now() - this.pointerStartTime > TagsManager.CLICK_MS_THRESHOLD) return;
    // Re-hit-test at the release point; the cursor may have drifted onto
    // an adjacent badge and we want the action to match what was released.
    const hit = this.findHitAt(e.clientX, e.clientY);
    if (!hit) {
      if (this.openTagId) this.closeModal();
      return;
    }
    if (hit.kind === 'cluster') {
      const handles = hit.ids
        .map((id) => this.tags.get(id)?.handle)
        .filter((h): h is TagHandle => !!h);
      const result = this.clusterConfig.onClick?.(handles, e as unknown as MouseEvent);
      if (result === false) return;
      void this.zoomToCluster(hit.ids);
      return;
    }
    const entry = this.tags.get(hit.id);
    if (!entry) return;
    const result = entry.options.onClick?.(entry.handle, e as unknown as MouseEvent);
    if (result === false) return;
    this.openTag(entry.options.id);
  };

  /**
   * Hit-test visible clusters and tags at viewport coords.
   *
   * Performance note: fires on every pointermove (cursor-feedback path), so it
   * runs frequently. We do exactly one `getBoundingClientRect()` per call (on
   * the canvas, to translate viewport coords → canvas coords) and reuse cached
   * tag dimensions instead of measuring every element. Cluster size is
   * hard-coded in CSS at 40 × 40, so no measurement is needed for clusters.
   */
  private findHitAt(x: number, y: number):
    | { kind: 'cluster'; ids: string[] }
    | { kind: 'tag'; id: string }
    | null {
    const canvasRect = this.renderer.dom.getBoundingClientRect();
    const cx = x - canvasRect.left;
    const cy = y - canvasRect.top;

    // Clusters: 40 × 40, centered on (centerX, centerY) — see `.hbd-cluster`
    // in defaultStyles.ts (transform: translate(-50%, -50%)).
    const half = CLUSTER_SIZE * 0.5;
    for (let i = 0; i < this.activeClusterCount; i++) {
      const el = this.clusterPool[i];
      if (el.hidden) continue;
      // Read the cluster's center from the translate property string — we
      // wrote it ourselves so the parse is deterministic. Falls back to a
      // bbox read only if the translate string isn't present yet.
      const t = el.style.translate;
      let centerX: number, centerY: number;
      if (t) {
        const sp = t.indexOf(' ');
        centerX = parseFloat(t);
        centerY = parseFloat(t.slice(sp + 1));
      } else {
        const r = el.getBoundingClientRect();
        centerX = r.left + r.width * 0.5 - canvasRect.left;
        centerY = r.top + r.height * 0.5 - canvasRect.top;
      }
      if (cx >= centerX - half && cx <= centerX + half &&
          cy >= centerY - half && cy <= centerY + half) {
        const ids = CLUSTER_IDS.get(el) ?? [];
        return { kind: 'cluster', ids };
      }
    }

    // Tags: anchor at (screenX, screenY); the element is offset by the CSS
    // base transform translate(-50%, calc(-100% - 6px)), so its visible bounds
    // in canvas coords are bottom-center = (screenX, screenY - 6).
    for (const entry of this.tags.values()) {
      if (!entry.inView || entry.element.hidden) continue;
      if (entry.cachedWidth <= 0 || entry.cachedHeight <= 0) {
        // Lazy first-frame measurement. The element is visible here (we
        // checked `hidden`), so getBoundingClientRect returns real dims.
        const r = entry.element.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          entry.cachedWidth = r.width;
          entry.cachedHeight = r.height;
        } else {
          continue;
        }
      }
      const w = entry.cachedWidth;
      const h = entry.cachedHeight;
      const left = entry.screenX - w * 0.5;
      const right = entry.screenX + w * 0.5;
      const bottom = entry.screenY - 6;
      const top = bottom - h;
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
        return { kind: 'tag', id: entry.options.id };
      }
    }
    return null;
  }

  private onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.openTagId) {
      this.closeModal();
    }
  };

  // ------------- Default tag DOM construction ------------------------------

  private buildDefaultTagElement(options: TagOptions): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'hbd-tag';
    el.dataset.id = options.id;
    const color = options.color ?? '#3b82f6';
    el.style.background = color;
    el.style.setProperty('--hbd-tag-color', color);
    if (options.textColor) el.style.color = options.textColor;

    if (options.icon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'hbd-tag-icon';
      if (typeof options.icon === 'string') {
        iconEl.textContent = options.icon;
      } else {
        const img = document.createElement('img');
        img.src = options.icon.src;
        img.alt = options.icon.alt ?? '';
        img.width = options.icon.width ?? 16;
        img.height = options.icon.height ?? 16;
        iconEl.appendChild(img);
      }
      el.appendChild(iconEl);
    }

    if (options.text) {
      const textEl = document.createElement('span');
      textEl.className = 'hbd-tag-text';
      textEl.textContent = options.text;
      el.appendChild(textEl);
    }

    if (options.badge) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'hbd-tag-badge';
      badgeEl.textContent = options.badge;
      el.appendChild(badgeEl);
    }

    return el;
  }

  private makeHandle(id: string): TagHandle {
    const self = this;
    return {
      get id() {
        return id;
      },
      get data() {
        return self.tags.get(id)?.options.data;
      },
      setPosition(lat: number, lon: number): void {
        const entry = self.tags.get(id);
        if (entry) {
          entry.options.lat = lat;
          entry.options.lon = lon;
        }
      },
      setText(text: string): void {
        const entry = self.tags.get(id);
        if (!entry) return;
        entry.options.text = text;
        const textEl = entry.element.querySelector<HTMLElement>('.hbd-tag-text');
        if (textEl) textEl.textContent = text;
        // Text-width change → cached hit-rect dims are stale.
        entry.cachedWidth = -1;
        entry.cachedHeight = -1;
      },
      setColor(color: string): void {
        const entry = self.tags.get(id);
        if (!entry) return;
        entry.options.color = color;
        entry.element.style.background = color;
        entry.element.style.setProperty('--hbd-tag-color', color);
      },
      open(): void {
        self.openTag(id);
      },
      close(): void {
        if (self.openTagId === id) self.closeModal();
      },
      remove(): void {
        self.removeTag(id);
      }
    };
  }
}
