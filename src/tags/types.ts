/**
 * Public API for the tags overlay system. Developers add tags to the map by
 * geographic position; tags render as DOM widgets positioned over the canvas,
 * cluster together when they would overlap on screen, and can open a modal
 * on click.
 */

export interface TagImageIcon {
  type: 'image';
  src: string;
  /** Width in pixels (default 16). */
  width?: number;
  /** Height in pixels (default 16). */
  height?: number;
  /** Alt text. */
  alt?: string;
}

export interface TagModalContent {
  /** Modal header text. */
  title?: string;
  /** Modal body — HTML string. Developer is responsible for sanitization. */
  body?: string;
  /** Additional class added to the modal root for styling. */
  className?: string;
}

export interface TagOptions {
  /** Unique identifier; pass to removeTag / getTag. */
  id: string;
  /** Geographic position. */
  lat: number;
  lon: number;

  // --- Built-in rendering options (used when `element` isn't provided) ---
  /** Background color of the tag pill. CSS color. Default '#3b82f6' (blue). */
  color?: string;
  /** Text color. Default 'white'. */
  textColor?: string;
  /** Icon: emoji/character, or { type: 'image', src, width?, height? }. */
  icon?: string | TagImageIcon;
  /** Primary text shown on the tag (e.g. '$1.2M'). */
  text?: string;
  /** Small badge text on the right (e.g. '3 BR'). */
  badge?: string;

  // --- Customization escape hatches ---
  /** Fully-custom DOM element used as the tag widget (overrides color/icon/text/badge). */
  element?: HTMLElement;
  /** Fully-custom DOM element used as the modal (overrides modal.title/body). */
  modalElement?: HTMLElement;

  /** Modal content (used when modalElement is not provided). */
  modal?: TagModalContent;

  /**
   * Vertical anchor in world meters above the ground. Useful for tags pinned
   * to a specific floor of a building — pass the floor's mid-Y so the badge
   * sits next to the floor band instead of at street level. Default 0.
   */
  elevation?: number;

  /** Click handler. Return `false` to suppress the default modal open. */
  onClick?: (handle: TagHandle, event: MouseEvent) => boolean | void;

  /** Arbitrary user data — round-tripped on the TagHandle. */
  data?: Record<string, unknown>;

  /**
   * Associate this tag with a specific building. When the tag's modal opens
   * the building gets a highlight overlay. The id must match a building's
   * `BuildingInfo.id` (from the MVT extractor) — see the `'buildingclick'`
   * event for how to discover ids interactively.
   */
  buildingId?: string;
  /**
   * Floor of the associated building (1-indexed). When set, the highlight
   * draws an additional band at the approximate floor elevation
   * (`height / levels` per floor, or 3 m if `levels` is unknown).
   */
  floor?: number;

  /**
   * Tags with higher priority "win" in clustering — when N tags merge, the
   * highest-priority one is shown as the representative behind the count.
   * Default 0.
   */
  priority?: number;
}

export interface TagHandle {
  readonly id: string;
  /** Move the tag to a new lat/lon. */
  setPosition(lat: number, lon: number): void;
  /** Update the tag's primary text. */
  setText(text: string): void;
  /** Update the tag's background color. */
  setColor(color: string): void;
  /** Open this tag's modal. */
  open(): void;
  /** Close the modal if it's currently showing this tag. */
  close(): void;
  /** Remove the tag from the map. */
  remove(): void;
  /** User data passed in at addTag time. */
  readonly data: Record<string, unknown> | undefined;
}

export interface ClusterOptions {
  /** Pixel distance below which tags merge into a cluster. Default 60. */
  mergeDistancePx?: number;
  /** Click handler. Return `false` to suppress the default zoom-in. */
  onClick?: (tags: TagHandle[], event: MouseEvent) => boolean | void;
  /** CSS color for the cluster bubble. Default '#3b82f6'. */
  color?: string;
}

export interface TagsConfig {
  cluster?: ClusterOptions;
  /** Inject default CSS into the document head. Default true. */
  injectDefaultStyles?: boolean;
}
