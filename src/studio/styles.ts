/**
 * Default CSS for the MapStudio control panel and compass widget. Injected
 * once into <head> on first studio construction unless disabled.
 */
export const DEFAULT_STUDIO_STYLES = /* css */ `
.hbd-studio {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 400px;
  max-height: calc(100% - 24px);
  background: rgba(255, 255, 255, 0.96);
  color: #1f2937;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  border-radius: 10px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  z-index: 20;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
.hbd-studio[data-collapsed="true"] {
  width: auto;
}
.hbd-studio-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: #f3f4f6;
  border-bottom: 1px solid #e5e7eb;
  font-weight: 600;
  cursor: pointer;
}
.hbd-studio[data-collapsed="true"] .hbd-studio-header {
  border-bottom: none;
}
.hbd-studio-title {
  font-size: 13px;
  letter-spacing: 0.02em;
}
.hbd-studio-toggle {
  background: none;
  border: none;
  font-size: 14px;
  color: #6b7280;
  cursor: pointer;
  padding: 0 4px;
}
.hbd-studio-body {
  overflow-y: auto;
  padding: 4px 0 8px;
}
.hbd-studio[data-collapsed="true"] .hbd-studio-body {
  display: none;
}
.hbd-studio-section {
  padding: 10px 14px;
  border-top: 1px solid #f1f3f5;
}
.hbd-studio-section:first-child {
  border-top: none;
}
.hbd-studio-section h4 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #6b7280;
}
.hbd-studio-note {
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.4;
  color: #9ca3af;
}
.hbd-studio-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 6px 0;
}
.hbd-studio-row label {
  flex: 1;
  font-size: 13px;
}
.hbd-studio-row input[type="range"] {
  flex: 1.4;
  accent-color: #3b82f6;
}
.hbd-studio-row .hbd-studio-value {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: #4b5563;
  min-width: 36px;
  text-align: right;
}
.hbd-studio-row .hbd-studio-range {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: #9ca3af;
  text-align: right;
  white-space: nowrap;
}
.hbd-studio-range-toggle {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #ffffff;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  color: #6b7280;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 120ms ease-out, color 120ms ease-out, background 120ms ease-out;
}
.hbd-studio-range-toggle:hover {
  border-color: #9ca3af;
  color: #1f2937;
}
.hbd-studio-range-toggle.active {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #ffffff;
}
.hbd-studio-range-rows {
  margin-left: 12px;
  padding: 4px 0 8px 8px;
  border-left: 2px solid #e5e7eb;
}
.hbd-studio-range-rows[hidden] { display: none; }
.hbd-studio-subrow {
  margin: 4px 0;
}
.hbd-studio-subrow label {
  flex: 0 0 36px;
  font-size: 11px;
  color: #6b7280;
}
.hbd-studio-row input[type="color"] {
  width: 32px;
  height: 22px;
  padding: 0;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
}
.hbd-studio-row input[type="checkbox"] {
  accent-color: #3b82f6;
  cursor: pointer;
}
.hbd-studio-theme-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px 8px 8px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  transition: border-color 140ms ease-out, box-shadow 140ms ease-out;
}
.hbd-studio-theme-toggle:hover {
  border-color: #cbd5f5;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.10);
}
.hbd-studio-theme-toggle[aria-expanded="true"] {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.30);
}
.hbd-studio-theme-toggle-swatches {
  display: flex;
  width: 56px;
  height: 26px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}
.hbd-studio-theme-toggle-swatches span { flex: 1; }
.hbd-studio-theme-toggle-label {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}
.hbd-studio-theme-toggle-chevron {
  font-size: 13px;
  color: #6b7280;
  transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.hbd-studio-theme-toggle[aria-expanded="true"] .hbd-studio-theme-toggle-chevron {
  transform: rotate(180deg);
}

.hbd-studio-theme-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
  margin-top: 12px;
  /* Padding around the grid so the active card's blue glow isn't clipped by
     overflow: hidden on any enclosing panel. */
  padding: 6px;
}
.hbd-studio-theme-grid[hidden] { display: none; }
.hbd-studio-theme-btn {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  transition:
    transform 140ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 140ms ease-out,
    border-color 140ms ease-out;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}
.hbd-studio-theme-btn:hover {
  transform: translateY(-1px);
  border-color: #cbd5f5;
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.12);
}
.hbd-studio-theme-btn:focus-visible {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.35);
}
.hbd-studio-theme-btn.active {
  border-color: #3b82f6;
  box-shadow:
    0 0 0 2px rgba(59, 130, 246, 0.45),
    0 8px 20px rgba(59, 130, 246, 0.18);
}
.hbd-studio-theme-btn.active::after {
  content: '✓';
  position: absolute;
  top: 6px;
  right: 7px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #3b82f6;
  color: white;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.45);
}
.hbd-studio-swatches {
  display: flex;
  flex: 1;
  width: 100%;
  height: 100%;
}
.hbd-studio-swatches span {
  flex: 1;
  height: 100%;
  border-radius: 0;
  border: none;
  transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.hbd-studio-theme-btn:hover .hbd-studio-swatches span:nth-child(odd) {
  transform: translateY(-2px);
}
.hbd-studio-theme-btn:hover .hbd-studio-swatches span:nth-child(even) {
  transform: translateY(2px);
}
.hbd-studio-theme-label {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: white;
  background: linear-gradient(
    to top,
    rgba(15, 23, 42, 0.78) 0%,
    rgba(15, 23, 42, 0.30) 70%,
    rgba(15, 23, 42, 0) 100%
  );
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
}
.hbd-studio-actions {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  background: #f9fafb;
  border-top: 1px solid #e5e7eb;
}
.hbd-studio-btn {
  flex: 1;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: white;
  color: #1f2937;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.hbd-studio-btn:hover {
  background: #f3f4f6;
}
.hbd-studio-btn.primary {
  background: #3b82f6;
  border-color: #2563eb;
  color: white;
}
.hbd-studio-btn.primary:hover {
  background: #2563eb;
}
`;

let injected = false;

/** Inject the default studio CSS once per document. */
export function injectDefaultStudioStylesOnce(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-here-be-dragons', 'studio');
  style.textContent = DEFAULT_STUDIO_STYLES;
  document.head.appendChild(style);
  injected = true;
}
