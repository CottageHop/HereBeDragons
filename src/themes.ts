import { Palette, type PaletteKey } from './materials/Palette.js';

export interface ThemeColors {
  water: string;
  /** Green / vegetation. Maps to landuse park/grass/wood. */
  park: string;
  /** Building wall color. Roof is derived as a darker shade. */
  building: string;
  /** Road color. Minor roads / paths are derived as lighter shades. */
  road: string;
  /** Background land color. Drives ground plane and the urban landuse tint. */
  land: string;
  /** Optional sand color for beaches and `landuse_sand`. Defaults to `#e8d8b0`. */
  beach?: string;
  /** Optional sky/fog color. Defaults to a lightened version of `land`. */
  sky?: string;
  /**
   * Optional outline-pass tuning. Comic / ink themes push these to make
   * edges thick and pure black; most themes omit them and inherit the
   * OutlinePass defaults set on construction.
   */
  outline?: {
    /** Multiplier on edge detection. >1 thickens outlines. Default 1.0. */
    strength?: number;
    /** Darkness of edged pixels (0 = pure black, 1 = unaltered). Default 0.6. */
    darkness?: number;
    /** Halftone-dot shading strength. 0 = off (default). Comic-style themes use ~0.7. */
    halftone?: number;
    /** Halftone cell size in pixels. Default 8. Larger = chunkier dots. */
    halftoneScale?: number;
    /** Edge-halo hatching strength. 0 = off (default). Comic-style themes use ~0.5. */
    hatching?: number;
    /** Hatching cell size in pixels. Default 14. */
    hatchingScale?: number;
  };
  /** Color saturation multiplier applied in the outline pass. Default 1.5. */
  saturation?: number;
  /**
   * Optional colors for the building selection overlay. When omitted the
   * cyan-silhouette + orange-floor-band defaults apply. Set per-theme so
   * loud palettes (e.g. cyberpunk) can pick highlights that pop against
   * the rest of the scene.
   */
  highlight?: {
    /** Silhouette / wireframe color. Default '#00d4ff' (cyan). */
    building?: string;
    /** Floor band color (lines + translucent fill). Default '#f97316' (orange). */
    floor?: string;
  };
}

/**
 * Themes ported from PolyMap. The five core slots map to a richer palette in
 * HereBeDragons via derived shades (see `themeToPaletteOverrides`).
 */
export const THEMES: Record<string, ThemeColors> = {
  cottagecore: {
    water: '#99b3a6',
    park: '#8c9959',
    building: '#d9b08f',
    road: '#8c7061',
    land: '#f2e6d9',
    beach: '#e8d8b0',
    sky: '#e6f0fa'
  },
  cottagecoredark: {
    water: '#4a7fb0',
    park: '#3e6b28',
    building: '#d9b08f',
    road: '#9a9a9a',
    land: '#1a2e1a',
    beach: '#5a4830',
    sky: '#2a3e2a'
  },
  cyberpunk: {
    water: '#0a1628',
    park: '#1a0a12',
    building: '#a82929',
    road: '#00d4e8',
    land: '#0c1020',
    beach: '#2a1018',
    sky: '#181028',
    highlight: {
      building: '#ffe600', // hot yellow
      floor:    '#7ec8ff'  // pale neon blue
    }
  },
  modern: {
    water: '#42a5f5',
    park: '#8bc34a',
    building: '#e0e0e0',
    road: '#bdbdbd',
    land: '#f5f5f5',
    beach: '#f0e8d0',
    sky: '#e6f0fa'
  },
  greyscale: {
    water: '#888888',
    park: '#aaaaaa',
    building: '#666666',
    road: '#777777',
    land: '#f0f0f0',
    beach: '#cccccc',
    sky: '#e8e8e8'
  },
  dark: {
    water: '#1a3a4a',
    park: '#1e3a1e',
    building: '#2a2a2a',
    road: '#5a5a5a',
    land: '#1a1a1a',
    beach: '#3a3a30',
    sky: '#2a2a2e'
  },
  eighties: {
    water: '#0099dd',
    park: '#7bef2a',
    building: '#e5573e',
    road: '#ff1493',
    land: '#ffd732',
    beach: '#ffefa0',
    sky: '#fff5c4'
  },
  seventies: {
    water: '#4ca8a8',
    park: '#f7c868',
    building: '#e87848',
    road: '#e03030',
    land: '#fdd998',
    beach: '#e8d8a0',
    sky: '#fde8c4'
  },
  oldworld: {
    water: '#5b7e8a',
    park: '#6b7c47',
    building: '#c4a265',
    road: '#8b4513',
    land: '#e8d5a3',
    beach: '#e8d4a0',
    sky: '#ecdcb4'
  },
  middleearth: {
    water: '#8fa6b2',
    park: '#4a5d3a',
    building: '#8b6f47',
    road: '#4a3525',
    land: '#e8d7a8',
    beach: '#d4be88',
    sky: '#e6ddc0'
  },
  // Concrete Jungle — moody urban palette with white-on-red selection.
  concretejungle: {
    land: '#b8b8b8',
    building: '#454545',
    park: '#8a8a30',
    water: '#1a3a4a',
    road: '#0a0a0a',
    beach: '#a0a0a0',
    sky: '#cfd2d4',
    highlight: {
      building: '#ffffff',
      floor: '#dd2222'
    }
  },
  // "Painted comic" — near-white surfaces with thick ink-black outlines,
  // saturation pulled to zero. Mimics a 3D object hand-painted to look 2D.
  comic: {
    water: '#e8eef2',
    park: '#f0f0f0',
    building: '#ffffff',
    road: '#1a1a1a',
    land: '#fbfaf6',
    beach: '#f4f0e6',
    sky: '#ffffff',
    outline: {
      strength: 2.4,
      darkness: 0.0,
      hatching: 0.55,
      hatchingScale: 14
    },
    saturation: 0.0
  }
};

export const THEME_NAMES = Object.keys(THEMES);

export type ThemeName = keyof typeof THEMES;

/** Mix `hex` with white by `amount` ∈ [0, 1]. */
export function lighten(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  return toHex(
    r + (255 - r) * amount,
    g + (255 - g) * amount,
    b + (255 - b) * amount
  );
}

/** Mix `hex` with black by `amount` ∈ [0, 1]. */
export function darken(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Map a PolyMap-style 5-color theme to HereBeDragons's full palette by deriving
 * variant shades for road classes, building roof, and landuse subtypes.
 */
export function themeToPaletteOverrides(
  theme: ThemeColors
): Partial<Record<PaletteKey, string>> {
  const beach = theme.beach ?? '#e8d8b0';
  return {
    ground: theme.land,
    water: theme.water,
    waterway: theme.water,
    road_major: theme.road,
    road_minor: lighten(theme.road, 0.18),
    road_path: lighten(theme.road, 0.32),
    // Rails: dark steel strip + creosoted-tie brown, derived from road so
    // they slot into each theme without needing per-theme entries.
    rail_strip: darken(theme.road, 0.45),
    rail_tie: darken(theme.road, 0.25),
    building: theme.building,
    building_top: darken(theme.building, 0.18),
    landuse_grass: lighten(theme.park, 0.12),
    landuse_park: theme.park,
    landuse_wood: darken(theme.park, 0.12),
    landuse_sand: beach,
    landuse_urban: lighten(theme.land, 0.05),
    beach
  };
}

/** Derived sky color used for both `scene.background` and `scene.fog`. */
export function themeSky(theme: ThemeColors): string {
  return theme.sky ?? lighten(theme.land, 0.3);
}

// Silence the unused-import linter — Palette is referenced via PaletteKey only.
void Palette;
