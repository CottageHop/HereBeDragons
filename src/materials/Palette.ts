/**
 * Named palette slots. ToonMaterials.get(slot) returns a cached MeshToonMaterial.
 * Values are illustration-style colors — gentle, slightly desaturated.
 */
// Extractors emit triangles wound so geometric normals match the lit side
// (roof/road/water/landuse face +Y; building walls face outward), so FrontSide
// renders correctly. Buildings stay DoubleSide as belt-and-suspenders for the
// rare case where the camera ends up inside a building from above.
// `polygonOffsetUnits` is the GL polygon-offset units value applied to the
// material. NEGATIVE values pull the polygon TOWARD the camera in the depth
// buffer, MORE NEGATIVE = drawn on top. This guarantees stable layer order
// at any view distance — unlike a small Y separation, which the depth buffer
// stops resolving once the camera is more than a few hundred meters away.
//
// Ordering (back to front, matches the physical Y stacking in landuse.ts):
// ground → urban → rail_tie → rail_strip → park → grass → sand → wood →
// water → waterway → road_path → road_minor → road_major.
//
// Rails draw UNDER parks, water, AND roads so that any of those layers
// covering a rail line reads as "the rail is below this surface" — useful
// for subway lines passing under streets, parks (e.g. Central Park's
// subterranean rail loops), or water (East River tunnel). Rails stay above
// landuse_urban so they remain visible in the dominant city fill. Waterway
// lines (rivers/canals) draw just above water polygons so a river entering
// a lake reads as a continuous channel.
export const Palette = {
  ground:       { color: '#dfd4c0', doubleSided: false, polygonOffsetUnits:   0 },
  rail_tie:     { color: '#6b4f33', doubleSided: false, polygonOffsetUnits:  -5 },
  rail_strip:   { color: '#3a3a3a', doubleSided: false, polygonOffsetUnits:  -7 },
  water:        { color: '#88b6d2', doubleSided: false, polygonOffsetUnits: -24 },
  waterway:     { color: '#88b6d2', doubleSided: false, polygonOffsetUnits: -26 },
  road_major:   { color: '#9a8f82', doubleSided: false, polygonOffsetUnits: -36 },
  road_minor:   { color: '#b4a99a', doubleSided: false, polygonOffsetUnits: -32 },
  road_path:    { color: '#c6b59f', doubleSided: false, polygonOffsetUnits: -28 },
  building:     { color: '#e8d8b8', doubleSided: true,  polygonOffsetUnits:   0 },
  building_top: { color: '#c9b691', doubleSided: true,  polygonOffsetUnits:   0 },
  landuse_grass:{ color: '#b9c98d', doubleSided: false, polygonOffsetUnits: -12 },
  landuse_park: { color: '#a0bf78', doubleSided: false, polygonOffsetUnits:  -8 },
  landuse_sand: { color: '#e6d7a9', doubleSided: false, polygonOffsetUnits: -16 },
  landuse_wood: { color: '#90ad7a', doubleSided: false, polygonOffsetUnits: -20 },
  landuse_urban:{ color: '#d9cdb6', doubleSided: false, polygonOffsetUnits:  -4 },
  beach:        { color: '#e8d8b0', doubleSided: false, polygonOffsetUnits: -16 },
  car_body:     { color: '#ffffff', doubleSided: false, polygonOffsetUnits:   0 }
} as const;

export type PaletteSlot = typeof Palette[keyof typeof Palette];
export type PaletteKey = keyof typeof Palette;
