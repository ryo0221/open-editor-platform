/**
 * The drawing domain's canonical content (docs/cad/drawing-editor.md, DW1, DW-U1/U2): the sheets
 * of a construction (施工図) or fabrication (制作図) drawing set, the views placed on them and
 * the notes written on them. A view names one exact saved version of a CAD or BIM Artifact by
 * its content hash and says how it is seen; what it shows (the projection, the cut) is derived
 * every time and never saved. Paper millimetres, x to the right and y up from the sheet's
 * lower-left corner. Schema 1 is the only schema: there is no migration path.
 */

export type Vec2 = [number, number];

export const drawingSchemaVersion = 1;

/** ISO 216 A sizes (JIS Z 8311), landscape width × height in mm. */
export const drawingSheetSizes = Object.freeze({
  A0: [1189, 841],
  A1: [841, 594],
  A2: [594, 420],
  A3: [420, 297],
  A4: [297, 210],
} as const);
export type DrawingSheetSize = keyof typeof drawingSheetSizes;
export const drawingSheetSizeNames = Object.keys(drawingSheetSizes) as DrawingSheetSize[];
export const drawingOrientations = ['landscape', 'portrait'] as const;
export type DrawingOrientation = (typeof drawingOrientations)[number];

/**
 * Scales a view may have (JIS B 0001's recommended ratios and the building scales of JIS A
 * 0150), as `paper:model`.
 */
export const drawingScales = [
  '50:1',
  '20:1',
  '10:1',
  '5:1',
  '2:1',
  '1:1',
  '1:2',
  '1:5',
  '1:10',
  '1:20',
  '1:50',
  '1:100',
  '1:200',
  '1:500',
  '1:1000',
  '1:2000',
  '1:5000',
] as const;
export type DrawingScale = (typeof drawingScales)[number];
/** Paper millimetres per model millimetre. */
export function drawingScaleFactor(scale: DrawingScale): number {
  const [paper, model] = scale.split(':').map(Number) as [number, number];
  return paper / model;
}

/** DW-U5: third-angle (JIS B 0001) by default; first-angle is the ISO alternative. */
export const drawingProjections = ['third-angle', 'first-angle'] as const;
export type DrawingProjection = (typeof drawingProjections)[number];

/** One exact saved version of a CAD or BIM Artifact the drawing sees. */
export interface DrawingSource {
  id: string;
  kind: 'cad' | 'bim';
  artifactId: string;
  versionId: string;
  contentHash: string;
  /** The Artifact's name when it was chosen (shown when the version cannot be read). */
  name: string;
}

/** The title block's fields (JIS Z 8311 表題欄). Empty strings are left blank on the sheet. */
export interface DrawingTitleBlock {
  title: string;
  drawingNumber: string;
  organization: string;
  project: string;
  /** Part drawings: the material and the quantity of one part. */
  material: string;
  quantity: string;
  drawnBy: string;
  checkedBy: string;
  approvedBy: string;
  /** `YYYY-MM-DD`, or empty. */
  date: string;
}
export const drawingTitleFields = [
  'title',
  'drawingNumber',
  'organization',
  'project',
  'material',
  'quantity',
  'drawnBy',
  'checkedBy',
  'approvedBy',
  'date',
] as const satisfies readonly (keyof DrawingTitleBlock)[];

/** One line of a sheet's revision table (改訂欄), oldest first. */
export interface DrawingRevision {
  id: string;
  /** `A`, `B`, … or `1`, `2`, …: unique on the sheet. */
  mark: string;
  date: string;
  description: string;
  by: string;
}

export interface DrawingSheet {
  id: string;
  name: string;
  size: DrawingSheetSize;
  orientation: DrawingOrientation;
  /** A 20 mm filing margin on the left (とじしろ) instead of the plain frame margin. */
  filing: boolean;
  title: DrawingTitleBlock;
  revisions: DrawingRevision[];
}

/** Standard view directions of a part or an assembly (the model's axes: z up, −y to the front). */
export const drawingDirections = [
  'front',
  'top',
  'right',
  'left',
  'bottom',
  'rear',
  'iso',
] as const;
export type DrawingDirection = (typeof drawingDirections)[number];

interface DrawingViewBase {
  id: string;
  sheetId: string;
  sourceId: string;
  name: string;
  /** The view's centre on the sheet (paper mm). */
  at: Vec2;
  scale: DrawingScale;
  /** Show the view's name and scale under it. */
  label: boolean;
}
/** An orthographic (or isometric) projection of a CAD part or assembly version (DW2). */
export interface DrawingCadView extends DrawingViewBase {
  kind: 'cad-projection';
  direction: DrawingDirection;
  /** Bodies drawn (a part's body IDs, or an assembly's occurrence IDs); none for all. */
  only: string[];
  hiddenLines: boolean;
  centerLines: boolean;
}
/**
 * A full section (断面図, DW2b) of a CAD projection: the parent's shape cut by the plane through
 * `line` square to the parent's paper, seen along the arrows (to the right of `line[0]` →
 * `line[1]`). The material between the viewer and the plane is taken away; the cut faces are
 * hatched. It sees the parent's source; the cutting-line symbol and `mark` are drawn on the
 * parent.
 */
export interface DrawingCadSection extends DrawingViewBase {
  kind: 'cad-section';
  parentId: string;
  /** The cutting line in the parent's view plane (model mm: x along its right, y along its up). */
  line: [Vec2, Vec2];
  /** `A` for `A–A`: unique among the drawing's sections and details. */
  mark: string;
  hiddenLines: boolean;
  centerLines: boolean;
}
/**
 * A detail view (詳細図, DW2b): the circle of `radius` around `center` of the parent (a projection
 * or a section) at the detail's own scale. The circle and `mark` are drawn on the parent.
 */
export interface DrawingCadDetail extends DrawingViewBase {
  kind: 'cad-detail';
  parentId: string;
  /** In the parent's view plane (model mm). */
  center: Vec2;
  /** Model mm. */
  radius: number;
  mark: string;
}
/**
 * DW5a (docs/cad/drawing-editor.md, 施工図): one of a building version's own drawing views (its
 * plan or section, by ID) on the sheet, cut and drawn by the Host as the building editor draws it,
 * at the view's scale here. Building drawings take the building editor's scales only.
 */
export interface DrawingBimView extends DrawingViewBase {
  kind: 'bim-view';
  /** The `BimView` ID in the source version. */
  bimViewId: string;
}
/** The scales a building drawing is drawn at (the building editor's: its symbols' sizes). */
export const drawingBimScales = [
  '1:50',
  '1:100',
  '1:200',
  '1:500',
  '1:1000',
] as const satisfies readonly DrawingScale[];
export type DrawingBimScale = (typeof drawingBimScales)[number];
/** DW5b: which side an elevation is seen from (the model's −y, +y, −x or +x). */
export const drawingElevationSides = ['front', 'rear', 'left', 'right'] as const;
export type DrawingElevationSide = (typeof drawingElevationSides)[number];
/**
 * DW5b: an elevation of the whole building (立面図), seen from outside on one side: drawn as the
 * building editor draws a section that cuts nothing, with its level marks and grid axes.
 */
export interface DrawingBimElevation extends DrawingViewBase {
  kind: 'bim-elevation';
  side: DrawingElevationSide;
}
/**
 * DW5b: a framing plan (伏図) of one level: its beams and members as centre lines marked with
 * their type's name, the columns that reach it from below, its grid axes and their dimensions.
 */
export interface DrawingBimFraming extends DrawingViewBase {
  kind: 'bim-framing';
  levelId: string;
}
/**
 * DW5b: a framing elevation (軸組図) along a grid axis: the columns, beams and members within
 * `bandMm` of it (all of them with 0) as centre lines in their heights, the levels across and
 * the axes that cross it.
 */
export interface DrawingBimFrame extends DrawingViewBase {
  kind: 'bim-frame';
  gridId: string;
  bandMm: number;
}
/** The views of a building version (DW5). */
export type DrawingBuildingView =
  | DrawingBimView
  | DrawingBimElevation
  | DrawingBimFraming
  | DrawingBimFrame;
export const drawingBuildingViewKinds = [
  'bim-view',
  'bim-elevation',
  'bim-framing',
  'bim-frame',
] as const satisfies readonly DrawingBuildingView['kind'][];
export const drawingIsBuildingView = (v: { kind: string }): v is DrawingBuildingView =>
  (drawingBuildingViewKinds as readonly string[]).includes(v.kind);
export type DrawingView =
  | DrawingCadView
  | DrawingCadSection
  | DrawingCadDetail
  | DrawingBuildingView;
export type DrawingViewKind = DrawingView['kind'];
export const drawingViewKinds = [
  'cad-projection',
  'cad-section',
  'cad-detail',
  ...drawingBuildingViewKinds,
] as const satisfies readonly DrawingViewKind[];
/** Marks of sections and details: JIS B 0001 leaves out I, O and Q (read as figures). */
export const drawingMarkPattern = /^[A-HJ-NPR-Z]{1,2}$/;

/** A note written on a sheet (注記). */
export interface DrawingNote {
  id: string;
  sheetId: string;
  kind: 'note';
  /** The text's lower-left corner (paper mm). */
  at: Vec2;
  text: string;
  /** Character height on paper: one of JIS Z 8313's sizes. */
  heightMm: DrawingTextHeight;
}
/**
 * A point or edge of a view's shape a dimension or leader is tied to (DW3): the anchor (placement
 * path and B-rep edge, 寸法のアンカー) and which of it. `model` is where it was when placed (model
 * mm), kept to tell a moved or changed shape later.
 */
export interface DrawingRef {
  path: string[];
  bodyId: string;
  /** The B-rep edge's index in its body's topology. */
  edge: number;
  /** An end of the edge, its circle's centre, or the edge itself (a direction or a circle). */
  point: DrawingRefPoint;
  /** The model point when it was picked (the stored place while unresolved). */
  model: [number, number, number];
  /**
   * DW3c: the edge's persistent name when it was picked (the CAD topology name as canonical
   * JSON). A newer version's edge of the same name takes the dimension over; none for imported
   * geometry, whose edges are followed by their index only.
   */
  name?: string;
}
export const drawingRefPoints = ['start', 'end', 'center', 'edge'] as const;
export type DrawingRefPoint = (typeof drawingRefPoints)[number];

/**
 * A dimension (寸法, DW3) in a view, measured on the 3D shape: horizontal or vertical on the
 * paper, aligned between two points, a circle's diameter or radius, or the angle between two
 * straight edges. `at` is where its dimension line (or text, for a diameter or radius) goes on
 * the paper; it moves with its view.
 */
export interface DrawingDimension {
  id: string;
  sheetId: string;
  kind: 'dimension';
  viewId: string;
  type: DrawingDimensionType;
  refs: DrawingRef[];
  /** Relative to the view's `at` (paper mm), so the dimension moves with its view. */
  at: Vec2;
  /** Replaces the measured value when not empty (a dimension written by hand). */
  text: string;
  /** Written after the value: a tolerance (`±0.05`, `+0.1/0`) or a fit (`H7`). */
  tolerance: string;
  heightMm: DrawingTextHeight;
}
export const drawingDimensionTypes = [
  'horizontal',
  'vertical',
  'aligned',
  'diameter',
  'radius',
  'angle',
] as const;
export type DrawingDimensionType = (typeof drawingDimensionTypes)[number];

/**
 * A note with a leader (引出線付きの注記, DW3): the arrow points at a point of a view's shape
 * (`ref`) or at a fixed place on the paper (`target`, sheet mm) when there is no ref.
 */
export interface DrawingLeader {
  id: string;
  sheetId: string;
  kind: 'leader';
  /** The view the ref is in (empty for a target on the paper). */
  viewId: string;
  ref: DrawingRef | null;
  target: Vec2;
  /** The text's lower-left corner: relative to the view's `at` with a view, else sheet mm. */
  at: Vec2;
  text: string;
  heightMm: DrawingTextHeight;
}

/**
 * A drawing symbol on a leader (DW3b): a geometric tolerance frame (幾何公差, JIS B 0021), a datum
 * (データム), a surface texture (表面性状, JIS B 0031) or a weld (溶接記号, JIS Z 3021). Like a
 * leader, it points at a ref of a view (and moves with it) or at a place on the paper.
 */
export interface DrawingSymbol {
  id: string;
  sheetId: string;
  kind: 'symbol';
  viewId: string;
  ref: DrawingRef | null;
  target: Vec2;
  /** Where the symbol sits: relative to the view's `at` with a view, else sheet mm. */
  at: Vec2;
  symbol: DrawingSymbolSpec;
  heightMm: DrawingTextHeight;
}
export type DrawingSymbolSpec =
  | {
      type: 'gdt';
      characteristic: DrawingGdtCharacteristic;
      /** The tolerance value (`0.05`). */
      tolerance: string;
      /** A cylindrical zone: Ø before the value. */
      diameter: boolean;
      /** Material condition after the value: maximum (Ⓜ) or least (Ⓛ). */
      modifier: '' | 'M' | 'L';
      /** Primary, secondary, tertiary datum letters. */
      datums: string[];
    }
  | { type: 'datum'; letter: string }
  | {
      type: 'surface';
      /** Any process, removal of material required, or not allowed. */
      process: 'any' | 'removal' | 'no-removal';
      /** The requirement (`Ra 1.6`). */
      text: string;
    }
  | {
      type: 'weld';
      weld: DrawingWeldType;
      /** The arrow side (below the reference line), the other side (above), or both. */
      side: 'arrow' | 'other' | 'both';
      /** Written before the symbol: leg length or depth (`6`). */
      size: string;
      /** Written after the symbol: length and pitch (`50(100)`). */
      length: string;
      allAround: boolean;
      field: boolean;
    };
export type DrawingSymbolType = DrawingSymbolSpec['type'];
export const drawingSymbolTypes = ['gdt', 'datum', 'surface', 'weld'] as const;
/** JIS B 0021's characteristics; the first four are forms and take no datum. */
export const drawingGdtCharacteristics = [
  'straightness',
  'flatness',
  'circularity',
  'cylindricity',
  'profile-line',
  'profile-surface',
  'parallelism',
  'perpendicularity',
  'angularity',
  'position',
  'concentricity',
  'symmetry',
  'circular-runout',
  'total-runout',
] as const;
export type DrawingGdtCharacteristic = (typeof drawingGdtCharacteristics)[number];
/** Characteristics that need a datum (orientation, location, run-out). */
export const drawingGdtNeedsDatum: readonly DrawingGdtCharacteristic[] = [
  'parallelism',
  'perpendicularity',
  'angularity',
  'concentricity',
  'symmetry',
  'circular-runout',
  'total-runout',
];
/** Forms: no datum. */
export const drawingGdtForms: readonly DrawingGdtCharacteristic[] = [
  'straightness',
  'flatness',
  'circularity',
  'cylindricity',
];
export const drawingWeldTypes = ['fillet', 'square', 'v', 'bevel', 'spot', 'plug'] as const;
export type DrawingWeldType = (typeof drawingWeldTypes)[number];
/** Datum letters: as section marks, without I, O and Q. */
export const drawingDatumPattern = /^[A-HJ-NPR-Z]{1,2}$/;
/** A fit or tolerance class written after a size (JIS B 0401): `H7`, `g6`, `H7/g6`. */
export const drawingFitPattern =
  /^(?:[A-Z]{1,2}\d{1,2})(?:\/[a-z]{1,2}\d{1,2})?$|^[a-z]{1,2}\d{1,2}$/;

/**
 * DW3c-2b (docs/cad/drawing-editor.md, PMI由来の注記): what a PMI item of an imported part says,
 * as a drawing writes it: a dimension's values and tolerance, a tolerance's characteristic (the
 * kernel's type name), value and datum letters, a datum's letter, a datum target.
 */
export type DrawingPmiItem =
  | {
      kind: 'dimension';
      /** `XCAFDimTolObjects_DimensionType` by name (`Size_Diameter`, `Location_LinearDistance`). */
      type: string;
      values: number[];
      deviation?: { lower: number; upper: number };
      qualifier?: 'min' | 'max' | 'avg';
    }
  | {
      kind: 'geometric-tolerance';
      /** `XCAFDimTolObjects_GeomToleranceType` by name (`Position`, `Flatness`). */
      type: string;
      value: number;
      zone?: 'D' | 'SD';
      modifiers: string[];
      /** A maximum tolerance (mm). */
      maxValue?: number;
      /** The datum letters, in compartment order (a common datum joined by `-`). */
      datums: string[];
      /** Each compartment's datum modifiers, when any compartment has some (same length). */
      datumModifiers?: string[][];
    }
  | { kind: 'datum'; name: string }
  | { kind: 'datum-target'; datum: string; number: number; type: string };
export type DrawingPmiKind = DrawingPmiItem['kind'];
export const drawingPmiKinds = [
  'dimension',
  'geometric-tolerance',
  'datum',
  'datum-target',
] as const;

/**
 * DW3c-2b: an annotation imported from a part's PMI. It names the item (its body's placement path,
 * the body, the item's ID and the PMI asset it came from) and keeps what the item said when it
 * was imported or last confirmed (`item`). A newer version is compared with that: changed values
 * are an update to confirm, a gone or stale item is expired (失効・要確認).
 */
export interface DrawingPmiNote {
  id: string;
  sheetId: string;
  kind: 'pmi';
  viewId: string;
  source: { path: string[]; bodyId: string; itemId: string; assetSha256: string };
  item: DrawingPmiItem;
  /** Where its text or frame sits, relative to the view's `at` (paper mm). */
  at: Vec2;
  heightMm: DrawingTextHeight;
}

/**
 * DW4 (docs/cad/drawing-editor.md, 組立図): a balloon (風船, JIS B 0001) on a part of an assembly
 * view. It points at an edge of the part (`ref`, as a leader does) and shows that part's item
 * number in the parts list, worked out from the version the view shows, never stored.
 */
export interface DrawingBalloon {
  id: string;
  sheetId: string;
  kind: 'balloon';
  viewId: string;
  ref: DrawingRef;
  /** The circle's centre, relative to the view's `at`. */
  at: Vec2;
  heightMm: DrawingTextHeight;
}

/**
 * DW4: the parts list (部品欄) of an assembly view's version: one row per part version (the flat
 * BOM, the balloons' numbers), worked out from the version, never stored. Item 1 sits on the
 * heading, the rest above it (JIS B 0001), so it can stand on the title block.
 */
export interface DrawingPartsList {
  id: string;
  sheetId: string;
  kind: 'parts-list';
  viewId: string;
  /** The table's lower-right corner (sheet mm). */
  at: Vec2;
  heightMm: DrawingTextHeight;
}

export type DrawingAnnotation =
  | DrawingNote
  | DrawingDimension
  | DrawingLeader
  | DrawingSymbol
  | DrawingPmiNote
  | DrawingBalloon
  | DrawingPartsList;
export type DrawingAnnotationKind = DrawingAnnotation['kind'];
export const drawingTextHeights = [2.5, 3.5, 5, 7, 10, 14] as const;
export type DrawingTextHeight = (typeof drawingTextHeights)[number];

export interface DrawingDocument {
  schemaVersion: 1;
  name: string;
  projection: DrawingProjection;
  sources: DrawingSource[];
  sheets: DrawingSheet[];
  views: DrawingView[];
  annotations: DrawingAnnotation[];
}

export interface DrawingDiagnostic {
  code: string;
  path: string;
  id?: string;
}

/** Initial safety limits (refused as `limit-*`); not performance promises. */
export const drawingLimits = Object.freeze({
  sources: 200,
  sheets: 500,
  views: 5_000,
  annotations: 50_000,
  revisions: 50,
  idCodePoints: 128,
  textCodePoints: 200,
  noteCodePoints: 2_000,
  jsonDepth: 32,
  contentBytes: 16 * 1024 * 1024,
});
