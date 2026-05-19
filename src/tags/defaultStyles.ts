/**
 * Default CSS for the tag overlay. Injected once into <head> when the
 * TagsManager is constructed (unless config.injectDefaultStyles is false).
 * Developers can override any of these by writing CSS targeting the same
 * class names with higher specificity, or by passing fully-custom `element`
 * / `modalElement` in their TagOptions.
 */
export const DEFAULT_TAG_STYLES = /* css */ `
.hbd-tags-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 5;
}

.hbd-tag,
.hbd-cluster {
  position: absolute;
  top: 0;
  left: 0;
  /* Drags and wheel scrolls pass through to the canvas (so the map can
     still pan/zoom even when the cursor is over a badge). TagsManager
     detects clicks via document-level pointerdown/up + a hit-test. */
  pointer-events: none;
  font-family: system-ui, -apple-system, sans-serif;
  /* Per-frame screen position is set via the separate translate CSS
     property (cheap individual transform component). The base transform
     here stays untouched and just centers the element on its anchor. */
  will-change: translate;
}

/* Block text-selection and native drag on tags + every descendant so a
   click-and-drag that happens to start on a badge can't paint a text-
   selection that extends across the map. WebKit prefix included for Safari. */
.hbd-tag,
.hbd-tag *,
.hbd-cluster,
.hbd-cluster * {
  -webkit-user-select: none;
  user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;
}

/* Specificity-matched hide rules — the base .hbd-tag / .hbd-cluster rules below
   set display:inline-flex / flex which would otherwise win over the browser's
   default [hidden] rule. */
.hbd-tag[hidden],
.hbd-cluster[hidden] {
  display: none;
}

.hbd-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 10px;
  border-radius: 14px;
  background: #3b82f6;
  color: white;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
  transform: translate(-50%, calc(-100% - 6px));
  transition: box-shadow 120ms ease-out;
}
.hbd-tag::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 6px solid var(--hbd-tag-color, #3b82f6);
  transform: translateX(-50%);
}
.hbd-tag:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.hbd-tag-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}
.hbd-tag-icon img {
  display: block;
}
.hbd-tag-text {
  line-height: 1.3;
}
.hbd-tag-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.25);
  font-size: 11px;
  font-weight: 600;
  margin-left: 2px;
}

.hbd-cluster {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #3b82f6;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), inset 0 0 0 3px rgba(255, 255, 255, 0.35);
  transform: translate(-50%, -50%);
  transition: box-shadow 120ms ease-out;
}
.hbd-cluster:hover {
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35), inset 0 0 0 3px rgba(255, 255, 255, 0.5);
}
/* The count text inside the cluster shouldn't intercept clicks — let them
   fall through to the cluster element so its click handler fires regardless
   of whether the digit or the surrounding ring was hit. */
.hbd-cluster-count {
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}

.hbd-modal {
  position: absolute;
  top: 0;
  left: 0;
  max-width: 320px;
  min-width: 200px;
  background: white;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  padding: 14px 16px;
  color: #1f2937;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  pointer-events: auto;
  /* Anchor offset only — per-frame screen position is set via the separate
     translate CSS property in TagsManager.updateModalPosition. */
  transform: translate(-50%, -100%);
  will-change: translate;
  z-index: 10;
}
.hbd-modal[hidden] { display: none; }
.hbd-modal-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  padding-right: 22px;
}
.hbd-modal-body {
  margin: 0;
  color: #4b5563;
}
.hbd-modal-close {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 24px;
  height: 24px;
  background: none;
  border: none;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  color: #9ca3af;
  padding: 0;
}
.hbd-modal-close:hover {
  color: #1f2937;
}
.hbd-modal::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -6px;
  width: 0;
  height: 0;
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  border-top: 7px solid white;
  transform: translateX(-50%);
  filter: drop-shadow(0 2px 1px rgba(0, 0, 0, 0.08));
}
`;

let injected = false;

/** Inject the default tag CSS once per document. */
export function injectDefaultStylesOnce(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-here-be-dragons', 'tags');
  style.textContent = DEFAULT_TAG_STYLES;
  document.head.appendChild(style);
  injected = true;
}
