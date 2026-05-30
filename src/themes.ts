import { Palette, type PaletteKey } from './materials/Palette.js';
import type { CloudPreset } from './rendering/CloudsPass.js';
import type { LightPreset } from './scene/Lights.js';

export type { CloudPreset, LightPreset };

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
  /**
   * Optional volumetric-cloud look for this theme. When present, applying the
   * theme reshapes the cloud pass (coverage, density, altitude, color) so a
   * theme can own its whole sky — e.g. the Ghibli theme's towering gold
   * cumulus. Omit to inherit the neutral default clouds.
   */
  clouds?: CloudPreset;
  /**
   * Optional lighting look for this theme. When present, applying the theme
   * retints the key/fill/ambient/hemisphere lights — e.g. the Ghibli theme's
   * warm golden-hour sun + soft sky fill. Omit to inherit the neutral default
   * lighting.
   */
  light?: LightPreset;
  /**
   * Optional painterly building treatment — a per-fragment storybook look
   * layered on top of the toon shading: warm plaster walls with a sunlit
   * vertical gradient, glowing window rows, terracotta-tinted roofs, and
   * per-building hand-painted color variation. Omit (or set `strength: 0`)
   * to keep flat toon-shaded buildings. See {@link ThemeBuildingStyle}.
   */
  buildingStyle?: ThemeBuildingStyle;
  /**
   * Strength (0..1) of the painterly watercolor wash applied to flat surfaces
   * — ground, water, landuse, beach. Turns CG-flat colour fields into uneven,
   * hand-painted gouache so the map reads like an animated drawing. Omit (or 0)
   * to keep flat toon fills. The Ghibli theme runs this near full.
   */
  surfacePainterly?: number;
  /**
   * Strength (0..1) of procedural road surfacing — cobblestone setts on
   * major/minor roads, mottled earth on paths. Omit (or 0) for plain ribbons.
   */
  roadTexture?: number;
  /**
   * Drifting spore / pollen motes in the air — soft glowing flecks that give
   * the scene a living, hand-animated atmosphere. The Ghibli theme enables it.
   */
  spores?: boolean;
}

/** Procedural painterly building look. See {@link ThemeColors.buildingStyle}. */
export interface ThemeBuildingStyle {
  /** Overall blend of the painterly look over flat toon shading. 0..1. Default 0. */
  strength?: number;
  /** Roof tint (hex) — roofs mix toward this. Defaults to a darkened wall color. */
  roof?: string;
  /** Lit-window glow color (hex). Default warm lamplight. */
  window?: string;
  /** Approx. floor height in meters that sets the window-row spacing. Default 3.5. */
  floorHeight?: number;
}

/**
 * Themes ported from PolyMap. The five core slots map to a richer palette in
 * HereBeDragons via derived shades (see `themeToPaletteOverrides`).
 */
export const THEMES: Record<string, ThemeColors> = {
  // "Ghibli" — a sunlit storybook valley. Lush technicolor meadows, warm
  // straw-and-plaster villages with terracotta roofs, luminous cyan water,
  // and a bright cerulean sky carrying towering gold-lit cumulus. Soft
  // painterly outlines (not hard ink) + a saturation lift give it the
  // hand-painted cel look. Buildings get extra warmth from a procedural
  // painterly shader keyed on this palette (see StylizedMaterials).
  ghibli: {
    water: '#5fb3c4',
    park: '#86c34a',
    // Soft, light cream plaster — the painterly building shader tints each
    // building a different cheerful pastel over this airy base.
    building: '#f0e7d0',
    road: '#c2a878',
    land: '#efe7c8',
    beach: '#ecd9a6',
    sky: '#aaddf2',
    outline: {
      // Gentle, warm-leaning linework rather than the default sketch ink.
      strength: 0.85,
      darkness: 0.72
    },
    saturation: 1.75,
    highlight: {
      building: '#fff4d6',
      floor: '#ff7a45'
    },
    // Castle-in-the-Sky cumulus: big, fluffy, sunlit gold tops with soft
    // blue-grey undersides, drifting slowly across a tall sky slab.
    clouds: {
      coverage: 0.42,
      densityScale: 4.6,
      altitudeMin: 650,
      altitudeMax: 1600,
      noiseScale: 0.0011,
      windSpeed: 6,
      cloudColor: '#fff6e6',
      shadowColor: '#b9c6dc'
    },
    // Golden-hour key light + a soft sky-blue/warm-ground hemisphere for the
    // painted glow. Sun stays dominant so toon shading still reads on walls.
    light: {
      sun: '#fff0cf',
      sunIntensity: 1.08,
      fillIntensity: 0.14,
      ambientIntensity: 0.07,
      hemiSky: '#bfe2f6',
      hemiGround: '#e6d4a6',
      hemiIntensity: 0.34
    },
    // Storybook village: warm plaster walls, glowing lamplit windows, and
    // weathered terracotta roofs — each house painted a slightly different
    // shade so a block reads as hand-illustrated rather than CAD-extruded.
    buildingStyle: {
      strength: 1.0,
      // Warm terracotta tile (the shader adds tile-row grooves + per-building
      // colour variety) — the red roofs sit warmly over the pastel walls.
      roof: '#b5573c',
      window: '#ffdc8c',
      floorHeight: 3.6
    },
    // Hand-painted gouache washes on the ground, meadows, and water so every
    // flat fill reads as a cel rather than a CG plane.
    surfacePainterly: 0.9,
    // Cobblestone streets + mottled dirt lanes.
    roadTexture: 1.0,
    // Drifting pollen motes in the air.
    spores: true
  },
  // "Professional" — a clean, neutral palette for client-facing real-estate
  // maps. Light off-white land, soft grey buildings, calm blue water, restrained
  // outlines, and a strong professional-blue highlight tuned for picking out
  // listings + comps. Deliberately omits every Ghibli FX (no painterly wash,
  // no road texture, no spores, no cloud preset, no light preset) so the map
  // reads as a polished business product rather than a stylized illustration.
  professional: {
    water: '#aac4d6',
    park: '#a4c19a',
    building: '#dde0e3',
    road: '#c0c2c4',
    land: '#eef0f1',
    beach: '#e0d8c4',
    sky: '#d6e2ec',
    saturation: 1.0,
    outline: { strength: 0.6, darkness: 0.5 },
    highlight: { building: '#2563eb', floor: '#3b82f6' }
  },
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
  greyscaledark: {
    water: '#0d0d0d',
    park: '#808080',
    building: '#383838',
    road: '#585858',
    land: '#d8d8d8',
    beach: '#c0c0c0',
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
