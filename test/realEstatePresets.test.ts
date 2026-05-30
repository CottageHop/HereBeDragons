import { describe, it, expect } from 'vitest';
import { REAL_ESTATE_TAG_PRESETS } from '../src/tags/realEstatePresets.js';

/**
 * The RE tag presets are an opinionated public surface — consumers spread them
 * into `addTag` for a polished, consistent listing look. These assert the keys
 * are stable (renaming would be a breaking change), every preset carries the
 * three fillable fields, and the object is frozen so consumers can't mutate
 * shared defaults across maps.
 */
describe('REAL_ESTATE_TAG_PRESETS', () => {
  it('exposes the seven standard listing states', () => {
    expect(Object.keys(REAL_ESTATE_TAG_PRESETS).sort()).toEqual(
      ['comp', 'forSale', 'newListing', 'openHouse', 'pending', 'sold', 'subject']
    );
  });

  it('each preset has color + icon + badge', () => {
    for (const [name, p] of Object.entries(REAL_ESTATE_TAG_PRESETS)) {
      expect(p.color, `${name}.color`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.icon, `${name}.icon`).toBeTruthy();
      expect(p.badge, `${name}.badge`).toBeTruthy();
    }
  });

  it('subject + comp are distinct blues (so subject pops against its comps)', () => {
    expect(REAL_ESTATE_TAG_PRESETS.subject.color).not.toBe(REAL_ESTATE_TAG_PRESETS.comp.color);
  });

  it('the preset map is frozen so consumers cannot mutate shared defaults', () => {
    expect(Object.isFrozen(REAL_ESTATE_TAG_PRESETS)).toBe(true);
  });
});
