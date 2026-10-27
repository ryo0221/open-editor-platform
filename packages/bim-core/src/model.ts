/**
 * Building (BIM) document model, schema 1 — the only schema (docs/cad/r2c-architecture.md, 文書のmodel).
 * Independent of the CAD document: it shares no types with `cad-core`.
 */

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
export interface BimGridAxis {
  id: string;
  label: string;
  start: Vec2;
  end: Vec2;
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
export interface BimMaterial {
  id: string;
  name: string;
  category: BimMaterialCategory;
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
  | { shape: 'box'; depthMm: number; widthMm: number; wallMm: number };

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
  | (TypeBase & { kind: 'column' | 'beam'; profile: BimProfile; materialId: string })
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
}
export interface BimSlab extends ElementBase {
  kind: 'slab';
  typeId: string;
  /** Height of the slab's top face. */
  top: BimLevelHeight;
  boundary: BimLoop;
  holes: BimLoop[];
}
export interface BimColumn extends ElementBase {
  kind: 'column';
  typeId: string;
  at: BimPoint;
  rotationRad: number;
  base: BimLevelHeight;
  top: BimTop;
  clipBy?: string;
}
export interface BimBeam extends ElementBase {
  kind: 'beam';
  typeId: string;
  start: BimPoint;
  end: BimPoint;
  /** Height of the beam's top face. */
  top: BimLevelHeight;
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
}
export interface BimPart extends ElementBase {
  kind: 'part';
  typeId: string;
  at: BimPoint;
  base: BimLevelHeight;
  rotationRad: number;
}
export type BimElement =
  | BimWall
  | BimSlab
  | BimColumn
  | BimBeam
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
export const bimDrawingScales = [50, 100, 200] as const;
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
  minStoreyMm: 1_000,
  maxStoreyMm: 100_000,
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
