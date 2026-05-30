import type { TagOptions } from './types.js';

/**
 * The subset of {@link TagOptions} a preset can fill — color/icon/badge — so
 * consumers can spread a preset into their own `addTag` call without
 * conflicting on identity (`id`, `lat`, `lon`) or content (`text`, `modal`).
 */
export type RealEstateMarker = Pick<TagOptions, 'color' | 'icon' | 'badge'>;

/**
 * Opinionated tag styling defaults for common real-estate listing states.
 * Spread into `map.addTag({ id, lat, lon, text, modal, ...preset })` to get a
 * polished, consistent listing look without picking colors for every status.
 *
 * Colors are tuned to read cleanly over the `professional` theme (which uses a
 * neutral palette) but stay legible on every built-in theme. The icons are
 * single-character emoji so they render without bundling assets.
 *
 * @example
 *   import { REAL_ESTATE_TAG_PRESETS as RE } from '@cottagehop/here-be-dragons';
 *   map.addTag({ id: 'l1', lat, lon, text: '$1.2M', ...RE.forSale });
 *   map.addTag({ id: 'l2', lat, lon, text: '$980K', ...RE.sold });
 *   map.addTag({ id: 'subject', lat, lon, text: 'Subject', ...RE.subject });
 */
export const REAL_ESTATE_TAG_PRESETS: Readonly<Record<string, RealEstateMarker>> = Object.freeze({
  /** Active listing. Green for "go". */
  forSale:    { color: '#16a34a', icon: '🏠', badge: 'For Sale' },
  /** Just listed (~last week). Strong red so it stands out from active. */
  newListing: { color: '#dc2626', icon: '🏠', badge: 'New' },
  /** Under contract / pending closure. Amber. */
  pending:    { color: '#f59e0b', icon: '🏠', badge: 'Pending' },
  /** Closed sale. Muted grey so closed comps recede against active listings. */
  sold:       { color: '#6b7280', icon: '🏠', badge: 'Sold' },
  /** Open-house event. Purple. */
  openHouse:  { color: '#9333ea', icon: '🚪', badge: 'Open House' },
  /** A comparable property used in valuation. Blue. */
  comp:       { color: '#3b82f6', icon: '📊', badge: 'Comp' },
  /** The subject property the analysis centers on. Strong blue + star. */
  subject:    { color: '#1d4ed8', icon: '⭐', badge: 'Subject' }
});

/** Names of every built-in preset (for typed iteration / UI). */
export type RealEstateTagPreset = keyof typeof REAL_ESTATE_TAG_PRESETS;
