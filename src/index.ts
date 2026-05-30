export { createHereBeDragons } from './HereBeDragons.js';
export { THEMES, THEME_NAMES } from './themes.js';
export type { ThemeColors, ThemeName, CloudPreset, LightPreset, ThemeBuildingStyle } from './themes.js';
export type {
  HereBeDragonsOptions,
  HereBeDragons,
  LayerName,
  LayerConfig,
  CameraView,
  FlyToOptions,
  HereBeDragonsEventName,
  TileLoadEvent,
  TileErrorEvent,
  NoiseSource,
  Unsubscribe,
  BoundingBox,
  OutlineConfig
} from './types.js';
export { COMMON_BOUNDS } from './bounds.js';
export type { CommonBoundsKey } from './bounds.js';
// Quality tiers — `detectGpuTier()` is exposed so apps can show the resolved
// tier in a settings UI or make their own downgrade decision.
export { detectGpuTier, resolveQualityProfile } from './rendering/quality.js';
export type { QualityOption, QualityLevel, QualityProfile } from './rendering/quality.js';
export type {
  TagOptions,
  TagHandle,
  TagImageIcon,
  TagModalContent,
  ClusterOptions,
  TagsConfig
} from './tags/types.js';
export { REAL_ESTATE_TAG_PRESETS } from './tags/realEstatePresets.js';
export type { RealEstateMarker, RealEstateTagPreset } from './tags/realEstatePresets.js';
export { createMapStudio, MapStudio } from './studio/MapStudio.js';
export type { StudioOptions, StudioConfig, MapStudio as MapStudioHandle } from './studio/types.js';
export type { PolygonOptions, PolygonHandle, PolygonPoint } from './polygons/types.js';
export { makeRadiusPolygon } from './polygons/radius.js';
export type { ParcelsConfig, ParcelClickEvent, ParcelClickListener } from './parcels/types.js';
export type {
  BuildingInfo,
  BuildingPopupConfig,
  BuildingPopupContent,
  BuildingClickEvent
} from './buildings/types.js';

export const VERSION = '0.1.0';
