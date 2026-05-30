import * as THREE from 'three';
import type { MapCameraController } from '../controls/MapCameraController.js';
import type { Renderer } from '../rendering/Renderer.js';
import type { BuildingMeta } from '../tiles/worker/extractors/buildings.js';
import { BUILDING_THREE_LAYER, BUILDING_MESHES, buildingMeshArray } from '../layers/BuildingsLayer.js';
import { injectBuildingPopupStylesOnce } from './popupStyles.js';
import type {
  BuildingInfo,
  BuildingPopupConfig,
  BuildingPopupContent
} from './types.js';

export interface BuildingsManagerDeps {
  container: HTMLElement;
  renderer: Renderer;
  camera: MapCameraController;
  scene: THREE.Scene;
  /**
   * Called whenever a canvas click changes the highlight overlay (select or
   * clear). The map runs render-on-demand — a building click moves no
   * camera and goes through no public setter, so without this nudge the new
   * highlight wouldn't paint until the next ~0.5 s heartbeat frame.
   */
  onSceneChange?: () => void;
}

export type BuildingClickListener = (info: BuildingInfo) => void;

/**
 * Picking, highlighting, and popup logic for buildings.
 *
 * Building meshes are tagged with `userData.imBuildingMesh = true` by
 * BuildingsLayer; this manager scans the scene for those meshes on demand
 * (raycast, id lookup). Highlight overlays are rendered as `LineSegments`
 * groups added to the scene, and the popup is a single DOM element parked
 * inside the map container that repositions each frame.
 *
 * Click/drag are distinguished by tracking pointerdown position and elapsed
 * time on pointerup — anything that moved more than ~5px or took longer than
 * 500ms is treated as a drag and ignored.
 */
export class BuildingsManager {
  private readonly renderer: Renderer;
  private readonly camera: MapCameraController;
  private readonly scene: THREE.Scene;
  /** Render-on-demand nudge — see BuildingsManagerDeps.onSceneChange. */
  private readonly onSceneChange: () => void;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  /** Scratch vector for manual world→view→clip transformation. Avoids the
   *  perspective-divide sign-flip Vector3.project() does when the anchor
   *  is behind the camera. */
  private readonly viewPos = new THREE.Vector3();

  // Highlight overlays.
  private readonly silhouetteMaterial: THREE.LineBasicMaterial;
  private readonly floorBandMaterial: THREE.LineBasicMaterial;
  private readonly floorFillMaterial: THREE.MeshBasicMaterial;
  private currentBuildingColor = '#00d4ff';
  private currentFloorColor = '#f97316';
  private silhouetteLines: THREE.LineSegments | null = null;
  private floorBandLines: THREE.LineSegments | null = null;
  private floorFillMesh: THREE.Mesh | null = null;
  /** y of the currently highlighted floor (popup anchor). NaN if no floor. */
  private highlightFloorY = NaN;
  /** World XZ centroid of the currently highlighted building. */
  private highlightCenter = new THREE.Vector3();
  /** Top of the highlighted building (popup anchor when no floor is set). */
  private highlightTopY = 0;

  // Popup DOM.
  private readonly popup: HTMLDivElement;
  private readonly popupTitle: HTMLHeadingElement;
  private readonly popupBody: HTMLDivElement;
  private popupCustomMounted: HTMLElement | null = null;

  private config: BuildingPopupConfig;
  private clickListeners = new Set<BuildingClickListener>();

  /** State of the currently selected building (drives popup follow-up + highlight). */
  private selected: BuildingInfo | null = null;
  /** The mesh whose blueprint flag is currently set; cleared on deselection. */
  private blueprintMesh: THREE.Mesh | null = null;

  // Pointer-tracking for click vs drag.
  private pointerStartX = 0;
  private pointerStartY = 0;
  private pointerStartTime = 0;
  private pointerDownActive = false;
  private static CLICK_PX_THRESHOLD = 5;
  private static CLICK_MS_THRESHOLD = 500;

  // Hover-raycast state (RAF-throttled so a fast-moving pointer can't burn
  // dozens of raycasts per second). Owns the canvas cursor when hovering a
  // building — swaps 'grab' for 'pointer' so users get the click affordance.
  private hoverRafHandle = 0;
  private pendingHoverClientX = 0;
  private pendingHoverClientY = 0;
  private hovering = false;
  /** Mesh + per-building-index currently hovered. The mesh stores the index in
   *  `userData.imHoveredBuildingIndex`, which BuildingsLayer's onBeforeRender
   *  pushes into the shared building shader's `uHoveredBuildingIndex` uniform
   *  for the per-fragment warm-brighten effect (mirroring the selection path). */
  private hoveredMesh: THREE.Mesh | null = null;

  // Bound handlers (kept as fields so they can be removed cleanly).
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPopupWheel = (e: WheelEvent): void => {
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
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerMoveHover: (e: PointerEvent) => void;
  private readonly onPointerLeaveHover: () => void;
  private readonly onDocPointerDown: (e: PointerEvent) => void;
  private readonly onDocKeyDown: (e: KeyboardEvent) => void;

  constructor(deps: BuildingsManagerDeps, config: BuildingPopupConfig = {}) {
    this.renderer = deps.renderer;
    this.camera = deps.camera;
    this.scene = deps.scene;
    this.onSceneChange = deps.onSceneChange ?? (() => {});
    this.config = { enabled: true, popupEnabled: false, ...config };

    if (this.config.injectDefaultStyles !== false) injectBuildingPopupStylesOnce();

    // Building meshes sit on a dedicated THREE layer (so the normal pass can
    // exclude them when flattened). The raycaster's default mask is layer 0
    // only, so it'd skip every building — enable the buildings layer here.
    this.raycaster.layers.enable(BUILDING_THREE_LAYER);

    this.silhouetteMaterial = new THREE.LineBasicMaterial({
      color: 0x00d4ff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false
    });
    this.floorBandMaterial = new THREE.LineBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false
    });
    this.floorFillMaterial = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.25,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false
    });
    // Honor any colors the developer passed up-front.
    this.applyHighlightColors(config.highlightColor, config.floorColor);

    // Popup chrome.
    this.popup = document.createElement('div');
    this.popup.className = 'hbd-building-popup';
    this.popup.hidden = true;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'hbd-building-popup-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearSelection();
    });
    this.popupTitle = document.createElement('h3');
    this.popupTitle.className = 'hbd-building-popup-title';
    this.popupBody = document.createElement('div');
    this.popupBody.className = 'hbd-building-popup-body';
    this.popup.appendChild(closeBtn);
    this.popup.appendChild(this.popupTitle);
    this.popup.appendChild(this.popupBody);
    // Mount on body so the popup floats above any container z-index or
    // overflow context. CSS position: fixed → coordinates are viewport-relative.
    document.body.appendChild(this.popup);

    // Forward wheel events on the popup to the canvas so MapControls can
    // still zoom even when the cursor is parked over the popup.
    this.popup.addEventListener('wheel', this.onPopupWheel, { passive: false });

    // Pointer handlers on the canvas: track movement to tell click from pan.
    this.onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      this.pointerStartX = e.clientX;
      this.pointerStartY = e.clientY;
      this.pointerStartTime = performance.now();
      this.pointerDownActive = true;
    };
    this.onPointerUp = (e: PointerEvent): void => {
      if (!this.pointerDownActive) return;
      this.pointerDownActive = false;
      if (!this.config.enabled) return;
      const dx = e.clientX - this.pointerStartX;
      const dy = e.clientY - this.pointerStartY;
      if (Math.hypot(dx, dy) > BuildingsManager.CLICK_PX_THRESHOLD) return;
      if (performance.now() - this.pointerStartTime > BuildingsManager.CLICK_MS_THRESHOLD) return;
      this.handleClick(e);
    };
    this.renderer.dom.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.dom.addEventListener('pointerup', this.onPointerUp);

    // Hover cursor: swap 'grab' for 'pointer' over a building so users get a
    // click affordance — the headline RE-shopping UX nicety. Each pointermove
    // schedules at most one RAF-driven raycast against the live building-mesh
    // registry, so a fast-moving pointer can't burn dozens of raycasts/sec.
    // Skipped while dragging (Renderer owns the 'grabbing' cursor then) and
    // while the building popup is disabled (no click action → no affordance).
    this.onPointerMoveHover = (e: PointerEvent): void => {
      if (this.pointerDownActive) return;
      if (!this.config.enabled) return;
      this.pendingHoverClientX = e.clientX;
      this.pendingHoverClientY = e.clientY;
      if (this.hoverRafHandle !== 0) return;
      this.hoverRafHandle = requestAnimationFrame(() => {
        this.hoverRafHandle = 0;
        this.processHoverRaycast();
      });
    };
    this.onPointerLeaveHover = (): void => {
      if (this.hoverRafHandle !== 0) {
        cancelAnimationFrame(this.hoverRafHandle);
        this.hoverRafHandle = 0;
      }
      if (this.hovering) {
        this.hovering = false;
        this.renderer.dom.style.cursor = 'grab';
      }
      // Clear the per-building highlight on the way out, otherwise the last
      // hovered building stays warm-tinted until the pointer returns.
      if (this.hoveredMesh) {
        this.hoveredMesh.userData.imHoveredBuildingIndex = -1;
        this.hoveredMesh = null;
        this.onSceneChange();
      }
    };
    this.renderer.dom.addEventListener('pointermove', this.onPointerMoveHover);
    this.renderer.dom.addEventListener('pointerleave', this.onPointerLeaveHover);

    // Outside-click + Escape close the popup.
    this.onDocPointerDown = (e: PointerEvent): void => {
      if (!this.selected) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (this.popup.contains(target)) return;
      // Let canvas clicks fall through to the pointerdown/up handlers above;
      // those decide whether to open a *new* building or close.
      if (this.renderer.dom === target) return;
      this.clearSelection();
    };
    this.onDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && this.selected) this.clearSelection();
    };
    document.addEventListener('pointerdown', this.onDocPointerDown);
    document.addEventListener('keydown', this.onDocKeyDown);
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  isPopupEnabled(): boolean {
    return !!this.config.popupEnabled;
  }

  setPopupConfig(config: BuildingPopupConfig): void {
    this.config = {
      enabled: true,
      popupEnabled: false,
      ...this.config,
      ...config
    };
    this.applyHighlightColors(config.highlightColor, config.floorColor);
  }

  /**
   * Update the highlight overlay colors. Pass undefined to leave a color
   * untouched. Called from HereBeDragons when applying a theme so the active
   * theme's `highlight` block overrides the defaults.
   */
  setHighlightColors(buildingColor: string | undefined, floorColor: string | undefined): void {
    this.applyHighlightColors(buildingColor, floorColor);
  }

  private applyHighlightColors(buildingColor: string | undefined, floorColor: string | undefined): void {
    if (buildingColor) {
      this.silhouetteMaterial.color.set(buildingColor);
      this.currentBuildingColor = buildingColor;
    }
    if (floorColor) {
      this.floorBandMaterial.color.set(floorColor);
      this.floorFillMaterial.color.set(floorColor);
      this.currentFloorColor = floorColor;
    }
  }

  getBuildingHighlightColor(): string {
    return this.currentBuildingColor;
  }

  getFloorHighlightColor(): string {
    return this.currentFloorColor;
  }

  on(_event: 'buildingclick', cb: BuildingClickListener): () => void {
    this.clickListeners.add(cb);
    return () => this.clickListeners.delete(cb);
  }

  /**
   * Explicitly select a building by id. Optionally pin a floor band. Returns
   * the building info if found, otherwise null (building may not be loaded).
   */
  selectBuilding(id: string, floor?: number): BuildingInfo | null {
    const found = this.findBuildingById(id);
    if (!found) return null;
    this.applySelection(found.meta, found.mesh, floor, found.index);
    return this.selected;
  }

  clearSelection(): void {
    this.selected = null;
    this.disposeHighlight();
    this.popup.hidden = true;
    this.popupCustomMounted?.remove();
    this.popupCustomMounted = null;
    if (!this.popup.contains(this.popupTitle)) this.popup.appendChild(this.popupTitle);
    if (!this.popup.contains(this.popupBody)) this.popup.appendChild(this.popupBody);
    // Highlight overlay just left the scene — request a repaint.
    this.onSceneChange();
  }

  /**
   * Called once per frame from the main loop so the popup tracks the
   * selected building. Re-evaluates visibility every frame, never
   * short-circuits on the current `hidden` state, and never re-hides based
   * on clip-space Z — that check previously suppressed the popup any time
   * the camera was even momentarily in an awkward orientation.
   */
  update(): void {
    if (!this.selected || !this.config.popupEnabled) {
      if (!this.popup.hidden) this.popup.hidden = true;
      return;
    }

    // Anchor low on the building so projection stays well-behaved even
    // when the camera tilts close to a tall tower. The floor-pinned case
    // uses the floor mid-Y; the default uses the smaller of the building's
    // own height and a conservative 30 m cap.
    const MAX_ANCHOR_Y = 30;
    const anchorY = Number.isFinite(this.highlightFloorY)
      ? this.highlightFloorY + 1.5
      : Math.min(this.highlightTopY, MAX_ANCHOR_Y);
    const cam = this.camera.three;
    cam.updateMatrixWorld();

    // World → view space directly so we can sanity-check the depth before
    // perspective divide. Vector3.project() does view→clip then divides by
    // w; for anchors behind the near plane, w is negative and the NDC
    // values flip sign, putting the popup at wildly wrong positions.
    this.viewPos
      .set(this.highlightCenter.x, anchorY, this.highlightCenter.z)
      .applyMatrix4(cam.matrixWorldInverse);

    // Three.js camera looks down -Z in view space. A point in front of
    // the camera has viewPos.z < -near. If it's at or behind the near
    // plane, hide the popup — there's no meaningful screen position.
    if (this.viewPos.z >= -cam.near) {
      if (!this.popup.hidden) this.popup.hidden = true;
      return;
    }
    if (this.popup.hidden) this.popup.hidden = false;

    // Safe to apply the projection matrix now.
    this.viewPos.applyMatrix4(cam.projectionMatrix);

    // Canvas viewport in PAGE coordinates — needed because the popup uses
    // position: fixed (viewport-relative) rather than container-relative.
    const rect = this.renderer.dom.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const localX = (this.viewPos.x * 0.5 + 0.5) * w;
    const localY = (1 - (this.viewPos.y * 0.5 + 0.5)) * h;
    const rawX = rect.left + localX;
    const rawY = rect.top + localY;

    // Clamp to the canvas viewport so the popup body stays fully visible
    // even when the anchor projects past an edge.
    const margin = 28;
    const popupHalfWidth = 150;
    const popupHeight = 80;
    const minX = rect.left + margin + popupHalfWidth;
    const maxX = rect.right - margin - popupHalfWidth;
    const minY = rect.top + margin + popupHeight;
    const maxY = rect.bottom - margin;
    const clampedX = Math.max(minX, Math.min(maxX, rawX));
    const clampedY = Math.max(minY, Math.min(maxY, rawY));
    // The base CSS `transform: translate(-50%, calc(-100% - 14px))` centers
    // the popup on its anchor. Use the separate `translate` property for the
    // per-frame screen position — cheaper than reassigning the full transform
    // string and lets the GPU keep the layer promoted.
    this.popup.style.translate =
      `${clampedX.toFixed(1)}px ${clampedY.toFixed(1)}px`;
  }

  dispose(): void {
    this.renderer.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.dom.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.dom.removeEventListener('pointermove', this.onPointerMoveHover);
    this.renderer.dom.removeEventListener('pointerleave', this.onPointerLeaveHover);
    if (this.hoverRafHandle !== 0) cancelAnimationFrame(this.hoverRafHandle);
    document.removeEventListener('pointerdown', this.onDocPointerDown);
    document.removeEventListener('keydown', this.onDocKeyDown);
    this.disposeHighlight();
    this.silhouetteMaterial.dispose();
    this.floorBandMaterial.dispose();
    this.floorFillMaterial.dispose();
    this.popup.removeEventListener('wheel', this.onPopupWheel);
    this.popup.remove();
  }

  // ---------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------

  /**
   * Hover affordance — RAF-throttled raycast against the building-mesh
   * registry. Two outputs:
   *   1. Cursor swap: 'grab' ↔ 'pointer' when over a building, so users get
   *      a click affordance. Idempotent (we only touch the cursor on flip).
   *   2. Per-building highlight: resolve the hit triangle to its
   *      buildingIndex and write it to the hovered mesh's userData. The
   *      building shader's `uHoveredBuildingIndex` uniform (pushed in
   *      BuildingsLayer.onBeforeRender) then warm-brightens that one
   *      building. When the hovered building changes, we trigger a redraw.
   */
  private processHoverRaycast(): void {
    const rect = this.renderer.dom.getBoundingClientRect();
    this.ndc.set(
      ((this.pendingHoverClientX - rect.left) / rect.width) * 2 - 1,
      -((this.pendingHoverClientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.ndc, this.camera.three);
    const hits = BUILDING_MESHES.size > 0
      ? this.raycaster.intersectObjects(buildingMeshArray(), false)
      : [];

    // Resolve the hovered mesh + per-building index, if any.
    let hitMesh: THREE.Mesh | null = null;
    let hitBuildingIdx = -1;
    if (hits.length > 0 && hits[0].face) {
      const mesh = hits[0].object as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const indexAttr = geo.getAttribute('buildingIndex') as THREE.BufferAttribute | undefined;
      if (indexAttr) {
        hitMesh = mesh;
        hitBuildingIdx = Math.round(indexAttr.getX(hits[0].face.a));
      }
    }
    const nowHovering = hitMesh !== null;

    // (1) Cursor — only touch on flip so we don't fight the 'grabbing' cursor.
    if (nowHovering !== this.hovering) {
      this.hovering = nowHovering;
      this.renderer.dom.style.cursor = nowHovering ? 'pointer' : 'grab';
    }

    // (2) Highlight — only update + redraw when the hovered (mesh, index) flips.
    const prevMesh = this.hoveredMesh;
    const prevIdx = (prevMesh?.userData.imHoveredBuildingIndex as number | undefined) ?? -1;
    if (hitMesh !== prevMesh || hitBuildingIdx !== prevIdx) {
      if (prevMesh && prevMesh !== hitMesh) prevMesh.userData.imHoveredBuildingIndex = -1;
      if (hitMesh) hitMesh.userData.imHoveredBuildingIndex = hitBuildingIdx;
      this.hoveredMesh = hitMesh;
      this.onSceneChange();
    }
  }

  private handleClick(e: PointerEvent): void {
    const rect = this.renderer.dom.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.ndc, this.camera.three);

    // Live building-mesh registry (populated by BuildingsLayer.build) —
    // avoids a full scene.traverse on every click.
    if (BUILDING_MESHES.size === 0) {
      if (this.selected) this.clearSelection();
      return;
    }
    const hits = this.raycaster.intersectObjects(buildingMeshArray(), false);
    if (hits.length === 0) {
      if (this.selected) this.clearSelection();
      return;
    }
    const hit = hits[0];
    const mesh = hit.object as THREE.Mesh;
    const buildings = mesh.userData.imBuildings as BuildingMeta[] | undefined;
    if (!buildings || !hit.face) {
      if (this.selected) this.clearSelection();
      return;
    }
    const geo = mesh.geometry as THREE.BufferGeometry;
    const indexAttr = geo.getAttribute('buildingIndex') as THREE.BufferAttribute | undefined;
    if (!indexAttr) return;
    // The attribute is uploaded as Float32 (see BuildingsLayer for why); round
    // back to integer for the lookup.
    const bIdx = Math.round(indexAttr.getX(hit.face.a));
    const meta = buildings[bIdx];
    if (!meta) return;

    // Re-clicking the currently selected building deselects it (toggle).
    if (this.selected && this.selected.id === meta.id) {
      this.clearSelection();
      return;
    }

    this.applySelection(meta, mesh, undefined, bIdx);
    const info = this.selected!;
    for (const cb of this.clickListeners) cb(info);
  }

  /**
   * Return the Y of the building roof under (x, z) in world meters, or 0 if
   * no building covers that point. Implemented via a downward raycast against
   * the registered building meshes — uses three.js's BVH so it's cheap even
   * with many loaded tiles. Called from TagsManager to auto-elevate badges
   * that sit on top of a building.
   */
  getElevationAt(x: number, z: number): number {
    if (BUILDING_MESHES.size === 0) return 0;
    this.raycaster.ray.origin.set(x, 10_000, z);
    this.raycaster.ray.direction.set(0, -1, 0);
    this.raycaster.near = 0;
    this.raycaster.far = 20_000;
    const hits = this.raycaster.intersectObjects(buildingMeshArray(), false);
    return hits.length > 0 ? hits[0].point.y : 0;
  }

  /**
   * Iterate over every loaded building (across all visible tiles), yielding
   * a `BuildingInfo` with its world-space centroid pre-baked. Useful for
   * lookups like "find the tallest building" without touching internals.
   */
  forEachBuilding(cb: (info: BuildingInfo) => void): void {
    for (const mesh of BUILDING_MESHES) {
      const buildings = mesh.userData.imBuildings as BuildingMeta[] | undefined;
      if (!buildings) continue;
      mesh.updateWorldMatrix(true, false);
      const tx = mesh.matrixWorld.elements[12];
      const tz = mesh.matrixWorld.elements[14];
      for (const meta of buildings) {
        cb({
          id: meta.id,
          height: meta.height,
          levels: meta.levels,
          footprintArea: meta.footprintArea,
          centroid: { x: meta.centroidX + tx, z: meta.centroidZ + tz },
          properties: meta.properties
        });
      }
    }
  }

  /** Resolve a building id to its meta + parent mesh + local index. */
  private findBuildingById(
    id: string
  ): { meta: BuildingMeta; mesh: THREE.Mesh; index: number } | null {
    for (const mesh of BUILDING_MESHES) {
      const buildings = mesh.userData.imBuildings as BuildingMeta[] | undefined;
      if (!buildings) continue;
      const idx = buildings.findIndex((b) => b.id === id);
      if (idx >= 0) return { meta: buildings[idx], mesh, index: idx };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Highlight + popup
  // ---------------------------------------------------------------------

  private applySelection(
    meta: BuildingMeta,
    mesh: THREE.Mesh,
    floor: number | undefined,
    buildingIndex: number
  ): void {
    this.disposeHighlight();

    // Flag this mesh's local building index for the blueprint shader. The
    // per-mesh onBeforeRender in BuildingsLayer reads this on every draw.
    mesh.userData.imSelectedBuildingIndex = buildingIndex;
    this.blueprintMesh = mesh;

    // Account for the mesh's world transform — tile meshes are placed by
    // their parent group, so the building's local XZ aren't necessarily
    // world XZ. Bake the transform into the highlight geometry once.
    mesh.updateWorldMatrix(true, false);
    const tx = mesh.matrixWorld.elements[12];
    const tz = mesh.matrixWorld.elements[14];
    this.highlightCenter.set(meta.centroidX + tx, 0, meta.centroidZ + tz);
    this.highlightTopY = meta.height;

    const silhouette = buildSilhouetteGeometry(meta, tx, tz);
    this.silhouetteLines = new THREE.LineSegments(silhouette, this.silhouetteMaterial);
    this.silhouetteLines.renderOrder = 5;
    this.silhouetteLines.frustumCulled = false;
    this.scene.add(this.silhouetteLines);

    let floorY = NaN;
    if (typeof floor === 'number' && floor > 0) {
      const floorHeight = meta.levels && meta.levels > 0
        ? meta.height / meta.levels
        : 3;
      const yBottom = Math.max(0, (floor - 1) * floorHeight);
      const yTop = Math.min(meta.height, floor * floorHeight);
      floorY = (yBottom + yTop) * 0.5;

      const edges = buildFloorBoxEdges(meta, tx, tz, yBottom, yTop);
      this.floorBandLines = new THREE.LineSegments(edges, this.floorBandMaterial);
      this.floorBandLines.renderOrder = 6;
      this.floorBandLines.frustumCulled = false;
      this.scene.add(this.floorBandLines);

      const fill = buildFloorBoxFillGeometry(meta, tx, tz, yBottom, yTop);
      this.floorFillMesh = new THREE.Mesh(fill, this.floorFillMaterial);
      this.floorFillMesh.renderOrder = 5;
      this.floorFillMesh.frustumCulled = false;
      this.scene.add(this.floorFillMesh);
    }
    this.highlightFloorY = floorY;

    this.selected = {
      id: meta.id,
      height: meta.height,
      levels: meta.levels,
      footprintArea: meta.footprintArea,
      centroid: { x: meta.centroidX + tx, z: meta.centroidZ + tz },
      properties: meta.properties,
      floor: typeof floor === 'number' && floor > 0 ? floor : undefined
    };

    this.renderPopup(this.selected);
    // New highlight geometry just entered the scene — request a repaint so
    // it shows immediately under render-on-demand.
    this.onSceneChange();
  }

  private disposeHighlight(): void {
    if (this.silhouetteLines) {
      this.scene.remove(this.silhouetteLines);
      (this.silhouetteLines.geometry as THREE.BufferGeometry).dispose();
      this.silhouetteLines = null;
    }
    if (this.floorBandLines) {
      this.scene.remove(this.floorBandLines);
      (this.floorBandLines.geometry as THREE.BufferGeometry).dispose();
      this.floorBandLines = null;
    }
    if (this.floorFillMesh) {
      this.scene.remove(this.floorFillMesh);
      (this.floorFillMesh.geometry as THREE.BufferGeometry).dispose();
      this.floorFillMesh = null;
    }
    if (this.blueprintMesh) {
      delete this.blueprintMesh.userData.imSelectedBuildingIndex;
      this.blueprintMesh = null;
    }
    this.highlightFloorY = NaN;
  }

  private renderPopup(info: BuildingInfo): void {
    if (!this.config.popupEnabled) {
      if (!this.popup.hidden) this.popup.hidden = true;
      return;
    }
    // Reset any custom-mounted popup body from the previous selection.
    if (this.popupCustomMounted) {
      if (this.popupCustomMounted.parentNode === this.popup) {
        this.popup.removeChild(this.popupCustomMounted);
      }
      this.popupCustomMounted = null;
    }
    // Make sure the default title/body nodes are mounted before we write
    // into them — they get pulled out when a previous custom HTMLElement
    // takes their place.
    if (!this.popup.contains(this.popupTitle)) this.popup.appendChild(this.popupTitle);
    if (!this.popup.contains(this.popupBody)) this.popup.appendChild(this.popupBody);

    const content = this.config.render
      ? this.config.render(info)
      : defaultPopupContent(info);
    if (content === null || content === undefined) {
      this.popup.hidden = true;
      return;
    }
    if (content instanceof HTMLElement) {
      if (this.popup.contains(this.popupTitle)) this.popup.removeChild(this.popupTitle);
      if (this.popup.contains(this.popupBody)) this.popup.removeChild(this.popupBody);
      this.popup.appendChild(content);
      this.popupCustomMounted = content;
    } else {
      this.popupTitle.textContent = content.title ?? '';
      this.popupTitle.hidden = !this.popupTitle.textContent;
      this.popupBody.innerHTML = content.body ?? '';
    }
    this.popup.className =
      'hbd-building-popup' +
      (typeof content === 'object' && 'className' in content && content.className
        ? ' ' + content.className
        : '');
    this.popup.hidden = false;
    // Make sure the popup is still mounted — in case it was detached.
    if (!document.body.contains(this.popup)) document.body.appendChild(this.popup);
    this.update();
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Build a silhouette wireframe for a (possibly multi-part) building. Each
 * outer ring uses its own extrusion height from `outerRingHeights`, so a
 * tall tower over a shorter base renders as the correct combined shape.
 */
function buildSilhouetteGeometry(
  meta: BuildingMeta,
  tx: number,
  tz: number
): THREE.BufferGeometry {
  const positions: number[] = [];
  const { outerRings: rings, outerRingRanges, outerRingHeights } = meta;
  for (let r = 0; r < outerRingRanges.length; r += 2) {
    const start = outerRingRanges[r];
    const end = outerRingRanges[r + 1];
    const height = outerRingHeights[r >> 1];
    for (let i = start; i < end; i++) {
      const j = i + 1 < end ? i + 1 : start;
      const xi = rings[i * 2] + tx;
      const zi = rings[i * 2 + 1] + tz;
      const xj = rings[j * 2] + tx;
      const zj = rings[j * 2 + 1] + tz;
      positions.push(xi, 0, zi, xj, 0, zj);
      positions.push(xi, height, zi, xj, height, zj);
      positions.push(xi, 0, zi, xi, height, zi);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  return geo;
}

/**
 * Wireframe edges of a floor slab — bottom loop, top loop, vertical
 * connectors per ring. Each ring is independently skipped if the floor
 * doesn't exist on that part (ring height < floor band).
 */
function buildFloorBoxEdges(
  meta: BuildingMeta,
  tx: number,
  tz: number,
  yBottom: number,
  yTop: number
): THREE.BufferGeometry {
  const positions: number[] = [];
  const { outerRings: rings, outerRingRanges, outerRingHeights } = meta;
  for (let r = 0; r < outerRingRanges.length; r += 2) {
    const ringHeight = outerRingHeights[r >> 1];
    if (yBottom >= ringHeight) continue;          // floor above this part — skip
    const top = Math.min(yTop, ringHeight);
    const start = outerRingRanges[r];
    const end = outerRingRanges[r + 1];
    for (let i = start; i < end; i++) {
      const j = i + 1 < end ? i + 1 : start;
      const xi = rings[i * 2] + tx;
      const zi = rings[i * 2 + 1] + tz;
      const xj = rings[j * 2] + tx;
      const zj = rings[j * 2 + 1] + tz;
      positions.push(xi, yBottom, zi, xj, yBottom, zj);
      positions.push(xi, top, zi, xj, top, zj);
      positions.push(xi, yBottom, zi, xi, top, zi);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  return geo;
}

/**
 * Wall-band fill for the highlighted floor — a triangulated ring around the
 * outer ring(s) between yBottom and yTop. Renders as a translucent slab so
 * the floor reads at any camera angle, not just from above.
 */
function buildFloorBoxFillGeometry(
  meta: BuildingMeta,
  tx: number,
  tz: number,
  yBottom: number,
  yTop: number
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const { outerRings: rings, outerRingRanges, outerRingHeights } = meta;
  for (let r = 0; r < outerRingRanges.length; r += 2) {
    const ringHeight = outerRingHeights[r >> 1];
    if (yBottom >= ringHeight) continue;
    const top = Math.min(yTop, ringHeight);
    const start = outerRingRanges[r];
    const end = outerRingRanges[r + 1];
    for (let i = start; i < end; i++) {
      const j = i + 1 < end ? i + 1 : start;
      const xi = rings[i * 2] + tx;
      const zi = rings[i * 2 + 1] + tz;
      const xj = rings[j * 2] + tx;
      const zj = rings[j * 2 + 1] + tz;
      const base = positions.length / 3;
      positions.push(
        xi, yBottom, zi,
        xj, yBottom, zj,
        xj, top,    zj,
        xi, top,    zi
      );
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(indices);
  return geo;
}

/** Fallback popup content when no custom render is configured. Shows
 *  name and address if available, otherwise a generic "Building" label. */
function defaultPopupContent(info: BuildingInfo): BuildingPopupContent {
  const p = info.properties;
  const name = strProp(p, 'name');
  const houseNumber = strProp(p, 'addr:housenumber') ?? strProp(p, 'addr_housenumber');
  const street = strProp(p, 'addr:street') ?? strProp(p, 'addr_street');
  const addr = houseNumber && street ? `${houseNumber} ${street}` : street ?? null;
  if (!name && !addr) {
    return { title: 'Building', body: '' };
  }
  const lines: string[] = [];
  if (addr) lines.push(`<p>${escapeHtml(addr)}</p>`);
  return { title: name ?? 'Building', body: lines.join('') };
}

function strProp(
  props: Record<string, string | number | boolean>,
  key: string
): string | null {
  const v = props[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
