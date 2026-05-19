/**
 * Default CSS for the compass overlay. Injected once on first Compass
 * construction so the compass works as a first-class feature without the
 * studio being mounted.
 */
export const DEFAULT_COMPASS_STYLES = /* css */ `
.hbd-compass {
  position: absolute;
  bottom: 16px;
  left: 16px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  z-index: 15;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
}
.hbd-compass[hidden] { display: none; }
.hbd-compass-needle {
  width: 6px;
  height: 38px;
  position: relative;
  transform-origin: 50% 50%;
  transition: transform 80ms linear;
}
.hbd-compass-needle::before,
.hbd-compass-needle::after {
  content: '';
  position: absolute;
  left: 0;
  width: 0;
  height: 0;
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
}
.hbd-compass-needle::before {
  top: 0;
  border-bottom: 19px solid #ef4444;
}
.hbd-compass-needle::after {
  bottom: 0;
  border-top: 19px solid #9ca3af;
}
.hbd-compass-label {
  position: absolute;
  top: 4px;
  font-size: 10px;
  font-weight: 700;
  color: #ef4444;
  font-family: system-ui, -apple-system, sans-serif;
  pointer-events: none;
}
`;

let injected = false;

export function injectCompassStylesOnce(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-here-be-dragons', 'compass');
  style.textContent = DEFAULT_COMPASS_STYLES;
  document.head.appendChild(style);
  injected = true;
}
