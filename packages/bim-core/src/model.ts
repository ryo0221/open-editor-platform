/**
 * Building (BIM) document model, schema 1 — the only schema (docs/cad/r2c-architecture.md, 文書のmodel).
 * Independent of the CAD document: it shares no types with `cad-core`.
 */
import type { GeometryTextureSet } from '@editor-platform/geometry-core';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/**
 * A loop vertex: `[x, y]`, or `[x, y, bulge]` when the edge to the next vertex is a circular arc.
 * `bulge` is tan(θ / 4) of the arc's sweep θ (positive counter-clockwise), 0 < |bulge| ≤ 1.
 */
export type BimLoopVertex = [number, number] | [number, number, number];
export type BimLoop = BimLoopVertex[];
/** A plan point: coordinates, or the intersection of two grid axes (it follows the axes). */
export type BimPoint = { xy: Vec2 } | { grid: [string, string] };
/** A height attached to a level: the level's elevation plus `offsetMm`. */
export interface BimLevelHeight {
  level: string;
  offsetMm: number;
}
/** A top: attached to a level, or a fixed height above the element's base. */
export type BimTop = BimLevelHeight | { heightMm: number };

export interface BimProject {
  name: string;
  /** Angle from the model +Y axis to true north, counter-clockwise. */
  trueNorthRad: number;
  siteElevationMm: number;
}
export interface BimLevel {
  id: string;
  name: string;
  elevationMm: number;
}
/** Which ends of a grid axis carry its bubble (TW0e). Omitted: both. */
export const bimGridBubbles = ['both', 'start', 'end', 'none'] as const;
export type BimGridBubbles = (typeof bimGridBubbles)[number];
export interface BimGridAxis {
  id: string;
  label: string;
  start: Vec2;
  end: Vec2;
  /** TW0e: the ends whose bubble is drawn (plans, drawings and the 3D view). Omitted: both. */
  bubbles?: BimGridBubbles;
}
/** Whether a grid axis draws its bubble at this end (TW0e). */
export function bimGridBubbleAt(axis: Pick<BimGridAxis, 'bubbles'>, end: 'start' | 'end') {
  const b = axis.bubbles ?? 'both';
  return b === 'both' || b === end;
}
export const bimMaterialCategories = [
  'concrete',
  'masonry',
  'metal',
  'wood',
  'glass',
  'insulation',
  'finish',
  'other',
] as const;
export type BimMaterialCategory = (typeof bimMaterialCategories)[number];
/**
 * #661: how a material's surfaces are drawn (glTF metal/roughness, each 0–1). `preset` is the
 * library preset the values were copied from (`geometryMaterialPresets`).
 */
export interface BimAppearance {
  /** `#rrggbb` sRGB. */
  color: string;
  opacity: number;
  roughness: number;
  metalness: number;
  preset?: string;
  /**
   * #662: image maps over the look, each a texture asset of the document. As in glTF, the
   * colour, roughness and metalness multiply the maps.
   */
  textures?: GeometryTextureSet;
}
/** #662: an image a material's texture names, kept by the Host by its hash. */
export interface BimAssetRef {
  id: string;
  kind: 'texture-png' | 'texture-jpeg';
  /** `sha256:<hex>` of the bytes. */
  sha256: string;
  byteLength: number;
  mediaType: 'image/png' | 'image/jpeg';
}
export interface BimMaterial {
  id: string;
  name: string;
  category: BimMaterialCategory;
  /** #661: absent, the elements made of it keep their kind's colour. */
  appearance?: BimAppearance;
}
export interface BimLayer {
  materialId: string;
  thicknessMm: number;
}
/** Parametric section of a column or beam. No product catalogue is stored. */
export type BimProfile =
  | { shape: 'rect'; widthMm: number; depthMm: number }
  | { shape: 'circle'; diameterMm: number }
  | { shape: 'h'; depthMm: number; widthMm: number; webMm: number; flangeMm: number }
  | { shape: 'l'; depthMm: number; widthMm: number; thicknessMm: number }
  | { shape: 'channel'; depthMm: number; widthMm: number; webMm: number; flangeMm: number }
  | { shape: 'box'; depthMm: number; widthMm: number; wallMm: number }
  /** #936: a circular hollow section (steel pipe); the wall is under the radius. */
  | { shape: 'pipe'; diameterMm: number; wallMm: number };

/** Common properties exported as `Pset_*Common` (R2c-U8). */
export interface BimCommonProperties {
  isExternal?: boolean;
  loadBearing?: boolean;
  fireRating?: string;
  reference?: string;
}
export type BimPropertyValue = string | number | boolean;
/** Values of user-defined property sets, by set ID and property name. */
export type BimPropertyValues = Record<string, Record<string, BimPropertyValue>>;
interface Described {
  common?: BimCommonProperties;
  properties?: BimPropertyValues;
}

interface TypeBase extends Described {
  id: string;
  name: string;
}
export type BimType =
  | (TypeBase & { kind: 'wall' | 'slab' | 'roof'; layers: BimLayer[] })
  | (TypeBase & { kind: 'column' | 'beam' | 'member'; profile: BimProfile; materialId: string })
  | (TypeBase & { kind: 'door' | 'window'; widthMm: number; heightMm: number })
  | (TypeBase & {
      kind: 'part';
      /** Exact version of a CAD part (R2b version reference, R2c-U2). */
      source: { artifactId: string; versionId: string; contentHash: string };
      /** Bounds the Host reported for the version, used while the source is unavailable. */
      hintBounds: { min: Vec3; max: Vec3 };
    });
export type BimTypeKind = BimType['kind'];

interface ElementBase extends Described {
  id: string;
  name?: string;
  /** GlobalId kept from an IFC import and written back on export. */
  ifcGlobalId?: string;
}
export type BimWallLocation = 'center' | 'left' | 'right';
export interface BimWall extends ElementBase {
  kind: 'wall';
  typeId: string;
  start: BimPoint;
  end: BimPoint;
  /** Arc axis: bulge of the arc from start to end. Absent for a straight wall. */
  bulge?: number;
  /** Where the axis lies in the wall, looking from start to end. */
  location: BimWallLocation;
  base: BimLevelHeight;
  top: BimTop;
  /** Cut by the underside of this roof (`halfSpace`); quantities then come from the kernel. */
  clipBy?: string;
  /**
   * LR2 (docs/cad/bim-lean-ramp.md): the wall leans by this angle (rad, at most 60° either way)
   * about its axis at the base, to the right looking from start to end (outward on a
   * counter-clockwise ring; an arc wall becomes a cone). The thickness is square to the faces.
   * Absent or 0: upright.
   */
  lean?: number;
}
export interface BimSlab extends ElementBase {
  kind: 'slab';
  typeId: string;
  /** Height of the slab's top face (along the slope's edge, for a sloped slab). */
  top: BimLevelHeight;
  boundary: BimLoop;
  holes: BimLoop[];
  /**
   * TW5: a sloped slab (a ramp). Its top is the plane through boundary edge `edge` (from vertex
   * `edge` to the next) at `top`, rising square to that edge to `endTop` at the boundary's corner
   * farthest from it. The thickness is vertical, the sides upright. Absent: level.
   */
  slope?: { edge: number; endTop: BimLevelHeight };
}
export interface BimColumn extends ElementBase {
  kind: 'column';
  typeId: string;
  at: BimPoint;
  rotationRad: number;
  base: BimLevelHeight;
  top: BimTop;
  clipBy?: string;
  /**
   * TW2: plan position of the column's top, for a column that leans. Absent: straight above
   * `at`. The section runs along the axis and its ends are square to it.
   */
  topAt?: BimPoint;
  /**
   * TW5: the top section's size as a share of the base's (0.1–1), a tapered column; the
   * section (walls included) scales about the axis and the sides are ruled. Absent: 1.
   */
  topScale?: number;
}
export interface BimBeam extends ElementBase {
  kind: 'beam';
  typeId: string;
  start: BimPoint;
  end: BimPoint;
  /** Height of the beam's top face (at its start, when it slopes). */
  top: BimLevelHeight;
  /** TW2: height of the top face at the end, for a sloping beam. Absent: level, at `top`. */
  endTop?: BimLevelHeight;
}
/** TW2: one end of a member: a plan point and the height of the member's axis there. */
export interface BimMemberEnd {
  at: BimPoint;
  height: BimLevelHeight;
}
/**
 * TW2: a straight member at any slope (a brace or a lattice diagonal), written to IFC as
 * `IfcMember`. Its section (a `member` type's profile) is centred on the axis from `start` to
 * `end`, the profile's depth upright (or along +y for a vertical member), turned by
 * `rotationRad` about the axis. Its ends are square to the axis.
 */
export interface BimMember extends ElementBase {
  kind: 'member';
  typeId: string;
  start: BimMemberEnd;
  end: BimMemberEnd;
  rotationRad: number;
}
export interface BimWallOpening {
  alongMm: number;
  sillMm: number;
  widthMm: number;
  heightMm: number;
}
export type BimOpening = ElementBase & { kind: 'opening'; hostId: string } & (
    | { wall: BimWallOpening }
    | { slab: { boundary: BimLoop } }
  );
export interface BimDoor extends ElementBase {
  kind: 'door';
  typeId: string;
  hostId: string;
  alongMm: number;
  flipFacing: boolean;
  flipHand: boolean;
}
export interface BimWindow extends ElementBase {
  kind: 'window';
  typeId: string;
  hostId: string;
  alongMm: number;
  sillMm: number;
  flipFacing: boolean;
}
/**
 * Roof shapes (R2c-U6): flat and mono-pitch on any boundary (R2c-2), gable and hip on a
 * rectangle (R2c-7). `base` is the underside at its lowest, at the eaves.
 * - Mono-pitch rises at `slopeRad` towards `directionRad`.
 * - Gable rises at `slopeRad` from the two sides parallel to the ridge (`ridgeRad`, which must
 *   run along a side) to the ridge in the middle.
 * - Hip rises at `slopeRad` from all four sides; the ridge runs along the longer sides (a
 *   square gives a pyramid).
 */
export type BimRoofShape =
  | { form: 'flat' }
  | { form: 'mono'; slopeRad: number; directionRad: number }
  | { form: 'gable'; slopeRad: number; ridgeRad: number }
  | { form: 'hip'; slopeRad: number };
export interface BimRoof extends ElementBase {
  kind: 'roof';
  typeId: string;
  base: BimLevelHeight;
  boundary: BimLoop;
  shape: BimRoofShape;
}
export interface BimSpace extends ElementBase {
  kind: 'space';
  number: string;
  base: BimLevelHeight;
  /** Absent: up to the next level above, which must exist. */
  top?: BimTop;
  boundary: BimLoop;
  /** TW1: rooms around a core or a shaft (at most `bimLimits.holes`). Absent: none. */
  holes?: BimLoop[];
}
export interface BimPart extends ElementBase {
  kind: 'part';
  typeId: string;
  at: BimPoint;
  base: BimLevelHeight;
  rotationRad: number;
}
/**
 * LR3: a spiral ramp around `center`, from `startAngleRad` turning by `sweepRad` (positive
 * counter-clockwise, at most 3 turns either way), between two radii. Its top is a helicoid: each
 * radius stays level and rises in step with the angle, from `base` (the top at the start) to
 * `top` (the top at the end). Its thickness (a `slab` type's layers) is measured vertically.
 */
export interface BimRamp extends ElementBase {
  kind: 'ramp';
  typeId: string;
  center: BimPoint;
  innerRadiusMm: number;
  outerRadiusMm: number;
  startAngleRad: number;
  sweepRad: number;
  base: BimLevelHeight;
  top: BimLevelHeight;
}
/**
 * LS5: a guard along a spiral ramp's inner or outer edge: a band as thick as its type's layers
 * (a wall type), standing `heightMm` above the ramp's top and rising with it.
 */
export interface BimRailing extends ElementBase {
  kind: 'railing';
  typeId: string;
  hostId: string;
  side: 'inner' | 'outer';
  heightMm: number;
}
/**
 * LS6: a straight flight of steps up `directionRad` from `start`, the plan point at the foot of
 * its first riser on its centre line, `widthMm` across. `risers` equal risers climb from `base`
 * to `top`, `treadMm` apart (one tread fewer than risers: the last riser reaches the top). Under
 * the steps a sloping waist as thick as its type's layers (a slab type), square to the pitch.
 */
export interface BimStair extends ElementBase {
  kind: 'stair';
  typeId: string;
  start: BimPoint;
  directionRad: number;
  widthMm: number;
  risers: number;
  treadMm: number;
  base: BimLevelHeight;
  top: BimLevelHeight;
}
export type BimElement =
  | BimWall
  | BimSlab
  | BimColumn
  | BimBeam
  | BimMember
  | BimRamp
  | BimRailing
  | BimStair
  | BimOpening
  | BimDoor
  | BimWindow
  | BimRoof
  | BimSpace
  | BimPart;
export type BimElementKind = BimElement['kind'];

export interface BimWallJoin {
  id: string;
  walls: [string, string];
  kind: 'butt' | 'miter';
  /** `butt`: the wall that runs through; the other stops at its face. */
  through?: string;
}
export type BimView =
  | {
      id: string;
      kind: 'plan';
      name: string;
      level: string;
      cutHeightMm: number;
      depthMm: number;
      scale: BimDrawingScale;
    }
  | {
      id: string;
      kind: 'section';
      name: string;
      line: [Vec2, Vec2];
      /** Looking to the left (`left`) or right of the line from its first point. */
      direction: 'left' | 'right';
      depthMm: number;
      scale: BimDrawingScale;
    };
/** Drawing scales (1:n). 1:500 and 1:1000 draw a whole tall building on a sheet (TW0c). */
export const bimDrawingScales = [50, 100, 200, 500, 1000] as const;
export type BimDrawingScale = (typeof bimDrawingScales)[number];
export const bimPropertyTypes = ['string', 'number', 'boolean', 'length'] as const;
export interface BimPropertySetDef {
  id: string;
  name: string;
  properties: { name: string; type: (typeof bimPropertyTypes)[number] }[];
}

export interface BimDocument {
  schemaVersion: 1;
  units: 'mm';
  axes: 'right-handed-z-up';
  project: BimProject;
  levels: BimLevel[];
  grids: BimGridAxis[];
  materials: BimMaterial[];
  types: BimType[];
  elements: BimElement[];
  joins: BimWallJoin[];
  views: BimView[];
  propertySets: BimPropertySetDef[];
  /**
   * #662: the texture images the materials name (absent when none). The closure is exact: an
   * image no material names is not kept.
   */
  assets?: BimAssetRef[];
}

export interface BimDiagnostic {
  code: string;
  path: string;
  severity: 'error' | 'warning';
  /** The element, join or other entity the problem is about. */
  id?: string;
  /** `duplicate-id`: the path that used the ID first. */
  firstPath?: string;
}

/** Safety limits (docs/cad/r2c-architecture.md, 上限). Proposals, not measured capacity. */
export const bimLimits = Object.freeze({
  coordinateMm: 1_000_000,
  /** Flatter arcs lose a wall's thickness to rounding; draw them straight. */
  arcRadiusMm: 1_000_000_000,
  minDimensionMm: 1,
  maxSectionMm: 10_000,
  /** LR2: how far a wall may lean either way (60°). */
  wallLeanRad: Math.PI / 3,
  /** LR3: how far a spiral ramp may turn either way (3 turns). */
  rampSweepRad: 6 * Math.PI,
  /** LS5: a railing stands at most this high above its ramp. */
  railingHeightMm: 3000,
  /**
   * LS6: what a stair's steps may be (where its shape holds together; no building-code check):
   * risers 50–250 mm high and 2–50 of them, treads 150–500 mm deep.
   */
  stair: { riserMm: [50, 250], risers: [2, 50], treadMm: [150, 500] },
  minStoreyMm: 1_000,
  /** As far as a coordinate reaches (TW0d): a tall tower's decks need no unused levels between. */
  maxStoreyMm: 1_000_000,
  levels: 64,
  gridAxes: 256,
  types: 1_000,
  materials: 256,
  elements: 10_000,
  joins: 20_000,
  views: 64,
  loopVertices: 1_024,
  holes: 16,
  openingsPerHost: 64,
  layers: 16,
  propertySets: 64,
  propertiesPerSet: 128,
  propertyStringCodePoints: 4_096,
  idCodePoints: 128,
  /** IFC's IfcLabel holds 255 characters; names and short texts stay within it. */
  nameCodePoints: 255,
  contentBytes: 4 * 1024 * 1024,
  jsonDepth: 32,
});
/** Linear tolerance for coincidence (join endpoints, a point on an axis). */
export const bimTolerance = 0.001;
/** Property-set names a user may not take (R2c-U8): internal names and IFC's prefixes. */
export const bimReservedPropertyPrefixes = ['EP_', 'Pset_', 'Qto_'] as const;

export const bimSchemaVersion = 1;
