/**
 * Default CSS for the scale-bar overlay. Injected once on first ScaleBar
 * construction so the widget works as a first-class feature without the
 * studio being mounted. Mirrors the compass-styles pattern.
 */
export const DEFAULT_SCALE_BAR_STYLES = /* css */ `
.hbd-scalebar {
  position: absolute;
  bottom: 16px;
  right: 16px;
  padding: 6px 8px 4px 8px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  border-radius: 4px;
  z-index: 15;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 11px;
  font-weight: 600;
  color: #1f2937;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 56px;
}
.hbd-scalebar[hidden] { display: none; }
.hbd-scalebar-label {
  margin-bottom: 3px;
  line-height: 1;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.hbd-scalebar-bar {
  height: 8px;
  border: 1.5px solid #1f2937;
  border-top: none;
  box-sizing: border-box;
  transition: width 120ms ease-out;
}
`;

let injected = false;

export function injectScaleBarStylesOnce(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-here-be-dragons', 'scalebar');
  style.textContent = DEFAULT_SCALE_BAR_STYLES;
  document.head.appendChild(style);
  injected = true;
}
