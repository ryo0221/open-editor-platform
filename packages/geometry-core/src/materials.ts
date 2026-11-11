/**
 * The material library shared by the CAD and bim views (issue #661, texture stage 1): physically
 * based looks (metal/roughness, as glTF), each one a preset that a document copies by value, so
 * a document never depends on this list to be drawn. Pure data: no Three.js.
 */

/** How a surface reflects light: glTF's metallic-roughness model, each 0–1. */
export interface GeometryFinish {
  /** 0 mirror-smooth to 1 fully diffuse. */
  roughness: number;
  /** 0 dielectric (paint, stone, wood) to 1 bare metal. */
  metalness: number;
}
/**
 * CR6a (docs/cad/car-design.md): the light a surface gives off, as glTF's emissive colour and
 * `KHR_materials_emissive_strength`: `#rrggbb` sRGB and a strength (0–50, 1 the colour as is).
 */
export interface GeometryEmission {
  color: string;
  strength: number;
}
/**
 * CR6a: how a look lets light through and gives off light, each optional (absent: opaque, no
 * light, as looks were before). `transmission` 0–1 is glTF's `KHR_materials_transmission` (a
 * clear lens is 1), `ior` 1–2.5 its `KHR_materials_ior` (1.5 when absent).
 */
export interface GeometryLight {
  emission?: GeometryEmission;
  transmission?: number;
  ior?: number;
}
/** CR6a: the ranges of the light values. */
export const geometryLightLimits = Object.freeze({
  emissionStrength: [0, 50] as const,
  transmission: [0, 1] as const,
  ior: [1, 2.5] as const,
  defaultIor: 1.5,
});
/** CR6a: the light values' problems, as `[field, problem]` (empty when they are valid). */
export function geometryLightProblems(look: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  const within = (v: unknown, [lo, hi]: readonly [number, number]) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (Object.hasOwn(look, 'emission')) {
    const e = look.emission as Record<string, unknown> | null;
    if (
      !e ||
      typeof e !== 'object' ||
      Array.isArray(e) ||
      Object.keys(e).some((k) => k !== 'color' && k !== 'strength') ||
      typeof e.color !== 'string' ||
      !/^#[0-9a-f]{6}$/i.test(e.color) ||
      !within(e.strength, geometryLightLimits.emissionStrength)
    )
      out.push(['emission', 'emission']);
  }
  if (
    Object.hasOwn(look, 'transmission') &&
    !within(look.transmission, geometryLightLimits.transmission)
  )
    out.push(['transmission', 'transmission']);
  if (Object.hasOwn(look, 'ior') && !within(look.ior, geometryLightLimits.ior))
    out.push(['ior', 'ior']);
  return out;
}
/** A look: `#rrggbb` sRGB base colour, opacity 0–1, the finish and (CR6a) its light. */
export interface GeometryLook extends GeometryFinish, GeometryLight {
  color: string;
  opacity: number;
}
/** The broad kind of a preset, as the bim materials' categories. */
export type GeometryMaterialCategory =
  | 'concrete'
  | 'masonry'
  | 'metal'
  | 'wood'
  | 'glass'
  | 'insulation'
  | 'finish'
  | 'other';
export interface GeometryMaterialPreset extends GeometryLook {
  /** Stable id stored in documents (`[a-z0-9-]`). */
  id: string;
  name: string;
  category: GeometryMaterialCategory;
}

/** The finish of a look that names none: what the views drew before materials (#661). */
export const geometryDefaultFinish: Readonly<GeometryFinish> = Object.freeze({
  roughness: 0.55,
  metalness: 0.05,
});

const preset = (
  id: string,
  name: string,
  category: GeometryMaterialCategory,
  color: string,
  roughness: number,
  metalness: number,
  opacity = 1,
  light: GeometryLight = {},
): GeometryMaterialPreset =>
  Object.freeze({
    id,
    name,
    category,
    color,
    opacity,
    roughness,
    metalness,
    ...(light.emission ? { emission: Object.freeze({ ...light.emission }) } : {}),
    ...(light.transmission !== undefined ? { transmission: light.transmission } : {}),
    ...(light.ior !== undefined ? { ior: light.ior } : {}),
  });

/** The presets, in the order a picker lists them. */
export const geometryMaterialPresets: readonly GeometryMaterialPreset[] = Object.freeze([
  preset('concrete', 'Concrete', 'concrete', '#b5b2ab', 0.9, 0),
  preset('concrete-polished', 'Polished concrete', 'concrete', '#a7a49e', 0.45, 0),
  preset('brick', 'Brick', 'masonry', '#a4553d', 0.85, 0),
  preset('stone', 'Stone', 'masonry', '#c9c1b2', 0.75, 0),
  preset('steel', 'Steel', 'metal', '#a9adb3', 0.4, 1),
  preset('stainless-steel', 'Stainless steel', 'metal', '#c8ccd0', 0.25, 1),
  preset('aluminium', 'Aluminium', 'metal', '#d4d7db', 0.35, 1),
  preset('brass', 'Brass', 'metal', '#c9a24b', 0.3, 1),
  preset('copper', 'Copper', 'metal', '#c07a4f', 0.3, 1),
  preset('oak', 'Oak', 'wood', '#b48a5a', 0.7, 0),
  preset('walnut', 'Walnut', 'wood', '#6b4a33', 0.65, 0),
  preset('glass', 'Clear glass', 'glass', '#dbe9ee', 0.05, 0, 0.3),
  preset('insulation', 'Insulation', 'insulation', '#e8d36a', 0.95, 0),
  preset('plaster', 'White plaster', 'finish', '#ece9e3', 0.85, 0),
  preset('paint-gloss', 'Gloss paint', 'finish', '#2f5d8a', 0.2, 0),
  preset('plastic-matte', 'Matte plastic', 'other', '#3a3d42', 0.8, 0),
  preset('rubber', 'Rubber', 'other', '#26282b', 0.95, 0),
  // CR6a: the car's parts. A lamp's reflector, its clear lens (PMMA), its lit bulbs, a seat's cover.
  preset('chrome', 'Chrome', 'metal', '#e8eaec', 0.04, 1),
  preset('lamp-lens', 'Lamp lens (clear PMMA)', 'glass', '#f6f9fb', 0.02, 0, 1, {
    transmission: 1,
    ior: 1.49,
  }),
  preset('lamp-white', 'Lamp light (white)', 'other', '#fffaf0', 0.3, 0, 1, {
    emission: { color: '#fff4e0', strength: 8 },
  }),
  preset('lamp-red', 'Lamp light (red)', 'other', '#b3141c', 0.3, 0, 1, {
    emission: { color: '#ff2a1f', strength: 6 },
  }),
  preset('fabric', 'Seat fabric', 'finish', '#3b3f46', 0.95, 0),
  preset('leather', 'Leather', 'finish', '#4a3426', 0.5, 0),
]);

const byId = new Map(geometryMaterialPresets.map((p) => [p.id, p]));
/** The preset with this id, or undefined. */
export const geometryMaterialPreset = (id: string): GeometryMaterialPreset | undefined =>
  byId.get(id);
/** The first preset of a category: the look of a bim material that names no preset. */
export const geometryCategoryPreset = (
  category: GeometryMaterialCategory,
): GeometryMaterialPreset | undefined =>
  geometryMaterialPresets.find((p) => p.category === category);
