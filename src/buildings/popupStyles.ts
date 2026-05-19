/** Default CSS for the building popup. Injected once on first use. */
export const DEFAULT_BUILDING_POPUP_STYLES = /* css */ `
.hbd-building-popup {
  /* Anchored to the viewport via position: fixed so the popup floats above
     any container z-index / overflow weirdness. Coordinates are computed
     from the canvas's getBoundingClientRect() in BuildingsManager.update. */
  position: fixed;
  top: 0;
  left: 0;
  max-width: 280px;
  min-width: 180px;
  background: white;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  padding: 12px 14px 14px;
  color: #1f2937;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  pointer-events: auto;
  /* Anchor offset stays here; per-frame screen position is set via the
     separate translate CSS property in BuildingsManager.update. */
  transform: translate(-50%, calc(-100% - 14px));
  will-change: translate;
  /* Higher than compass (15), studio (20), and theme dock (10) so it never
     gets hidden behind another overlay. */
  z-index: 9999;
  user-select: none;
  -webkit-user-select: none;
}
.hbd-building-popup[hidden] { display: none; }
.hbd-building-popup-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  padding-right: 22px;
}
.hbd-building-popup-body {
  margin: 0;
  color: #4b5563;
}
.hbd-building-popup-body p { margin: 2px 0; }
.hbd-building-popup-close {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 22px;
  height: 22px;
  background: none;
  border: none;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: #9ca3af;
  padding: 0;
}
.hbd-building-popup-close:hover {
  color: #1f2937;
}
.hbd-building-popup::after {
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

export function injectBuildingPopupStylesOnce(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-here-be-dragons', 'building-popup');
  style.textContent = DEFAULT_BUILDING_POPUP_STYLES;
  document.head.appendChild(style);
  injected = true;
}
