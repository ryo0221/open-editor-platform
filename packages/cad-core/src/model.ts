/**
 * CAD schema 2 (docs/cad/model.md, docs/cad/r1-modeling.md), the only schema: CAD is unreleased,
 * so schema 1 is not read. Pure data: no functions, typed arrays, URLs or Wasm handles.
 */
import type {
  CadComponent,
  CadComponentPattern,
  CadJoint,
  CadPartDef,
  CadPartProperties,
  CadSolvedPose,
} from './assembly';
import type { CadExpression, CadParameterType } from './expression';
import type { CadSketch, CadSketchRegion } from './sketch';
import type { CadTopologyRef } from './topology';

export type Length =
  | { literalMm: number }
  | { parameterId: string }
  | { affine: { parameterId: string; scale: number; offsetMm: number } }
  | { expression: CadExpression };
export type Angle =
  | { literalRad: number }
  | { parameterId: string }
  | { expression: CadExpression };
/** A whole number of copies, 1–1,000: a literal, a count parameter or a dimensionless expression. */
export type Count = { literal: number } | { parameterId: string } | { expression: CadExpression };
/** K6 (docs/cad/complex-models.md): a dimensionless factor, a literal or an expression. */
export type CadRatio = { literal: number } | { expression: CadExpression };
export type Position3 = [Length, Length, Length];
/** Unit quaternion `[x, y, z, w]`; `|norm - 1| <= quaternionNormTolerance`. */
export type Quaternion = [number, number, number, number];
export type Vec3 = [number, number, number];

export interface CadKernelProfile {
  id: string;
  /** Exact evaluator identity (`sha256:<hex>`), pinned by the kernel gate. */
  buildHash: string;
  /** Equals the document's schemaVersion. */
  semanticsVersion: CadSchemaVersion;
  linearToleranceMm: number;
  angularToleranceRad: number;
  maxResultLinearToleranceMm: number;
}
/** mm for length, rad for angle, an integer for count; a value or an expression. */
export type CadParameter = {
  id: string;
  name: string;
  type: CadParameterType;
} & ({ value: number; expression?: never } | { expression: CadExpression; value?: never });
/** u/v axes are the orientation applied to world +X/+Y; the normal is +Z. */
export interface CadPlane {
  origin: Position3;
  orientation: Quaternion;
}
export interface CadPolylineVertex {
  id: string;
  u: Length;
  v: Length;
}
/** Rectangle lower-left and circle centre are the plane origin. Polylines close implicitly. */
export type CadProfileShape =
  | { type: 'rectangle'; width: Length; height: Length }
  | { type: 'circle'; radius: Length }
  | { type: 'polyline'; vertices: CadPolylineVertex[] };
export interface CadProfile {
  id: string;
  name: string;
  plane: CadPlane;
  shape: CadProfileShape;
}
interface FeatureBase {
  id: string;
  name: string;
}
/** What an extrude or revolve sweeps: a D1 profile, or a closed region of a sketch (R1d). */
export type CadSweepSource = { profileId: string } | CadSketchSection;
/** A closed region of a sketch: what a loft passes through or a sweep carries (R1d, R1e). */
export interface CadSketchSection {
  sketchId: string;
  region: CadSketchRegion;
}
/**
 * K6 (docs/cad/complex-models.md, CM-7): a loft section copied from an earlier sketch section of
 * the same loft. Its region is scaled by `scale` about the source sketch's origin, turned by
 * `angle` about the sketch's normal there, then moved by `offset` (u, v in the sketch plane, then
 * along its normal). It has no constraints of its own: it follows the source sketch.
 */
export interface CadDerivedSection {
  derivedFrom: number;
  offset: Position3;
  scale: CadRatio;
  angle: Angle;
}
/** One section of a loft: a sketch region, or one derived from an earlier section (K6). */
export type CadLoftSection = CadSketchSection | CadDerivedSection;
/** A sweep's path: an open chain of lines and arcs of a sketch, end to end, in order (R1e). */
export interface CadSketchPath {
  sketchId: string;
  elements: string[];
}
/**
 * R2a-2c: a chain of edges of one feature's result, end to end in order (a loft section
 * from existing geometry). The references are read, never consumed.
 */
export interface CadEdgeChain {
  edges: CadTopologyRef[];
}
/**
 * R2a-2c: one curve of a surface feature's boundary: a line, arc or open spline of a sketch, or
 * an edge of a feature's result (read, never consumed).
 */
export type CadCurveSource = { sketchId: string; element: string } | { edge: CadTopologyRef };
/**
 * R2a-3: what a trim cuts a sheet with: a closed chain of a sketch projected along the sketch's
 * normal (kept `inside` or `outside`), a plane, or another sheet's result (read, never consumed;
 * kept on the `front` its normal faces, or the `back`).
 */
export type CadTrimTool =
  | CadSketchPath
  | { plane: { origin: Position3; normal: Vec3 } }
  | { featureId: string };
/** Box `origin` is its local minimum corner, cylinder origin its base centre (+Z axis), sphere origin its centre. */
export type CadFeature =
  | (FeatureBase & {
      type: 'box';
      inputFeatureIds: [];
      args: { size: [Length, Length, Length]; origin: Position3; orientation: Quaternion };
    })
  | (FeatureBase & {
      type: 'cylinder';
      inputFeatureIds: [];
      args: { radius: Length; height: Length; origin: Position3; orientation: Quaternion };
    })
  | (FeatureBase & {
      type: 'sphere';
      inputFeatureIds: [];
      args: { radius: Length; origin: Position3; orientation: Quaternion };
    })
  | (FeatureBase & {
      type: 'extrude';
      inputFeatureIds: [];
      args: CadSweepSource & { distance: Length; direction: 1 | -1 };
    })
  | (FeatureBase & {
      type: 'revolve';
      inputFeatureIds: [];
      /** Axis origin in plane u/v; direction is a unit u/v vector. */
      args: CadSweepSource & {
        axisOrigin: [Length, Length];
        axisDirection: [number, number];
        angle: Angle;
      };
    })
  | (FeatureBase & {
      /**
       * A solid through 2–32 sections in order (docs/cad/r1-modeling.md, Loft・sweep), each a
       * region without holes of its own sketch. `ruled` joins neighbouring sections by straight
       * faces; otherwise one smooth surface passes through them all.
       */
      type: 'loft';
      inputFeatureIds: [];
      args: { sections: CadLoftSection[]; ruled: boolean };
    })
  | (FeatureBase & {
      /**
       * The region `profile` (without holes) carried along `path`, which starts where the profile
       * is. `frenet` turns the profile with the path's curvature; `fixed` keeps its orientation.
       */
      type: 'sweep';
      inputFeatureIds: [];
      args: { profile: CadSketchSection; path: CadSketchPath; orientation: 'frenet' | 'fixed' };
    })
  | (FeatureBase & {
      /**
       * R2a: a sheet (docs/cad/r2a-freeform.md, 曲面featureと操作): the chain `path` of lines and
       * arcs, open or closed, carried `distance` along its sketch's normal.
       */
      type: 'extrudeSurface';
      inputFeatureIds: [];
      args: { path: CadSketchPath; distance: Length; direction: 1 | -1 };
    })
  | (FeatureBase & {
      /** R2a: a sheet: the chain `path` turned `angle` about an axis in its sketch's plane. */
      type: 'revolveSurface';
      inputFeatureIds: [];
      /** Axis origin in plane u/v; direction is a unit u/v vector. */
      args: {
        path: CadSketchPath;
        axisOrigin: [Length, Length];
        axisDirection: [number, number];
        angle: Angle;
      };
    })
  | (FeatureBase & {
      /**
       * R2a: a sheet through 2–32 chains in order, each of its own sketch, all open or all
       * closed. Faces take the first chain's element names; `ruled` as for a loft.
       */
      type: 'surfaceLoft';
      inputFeatureIds: [];
      args: { sections: (CadSketchPath | CadEdgeChain)[]; ruled: boolean };
    })
  | (FeatureBase & {
      /**
       * R2a: a sheet: the chain `profile` (open or closed) carried along `path` (an open chain of
       * another sketch, as a sweep's), with a sweep's `orientation`.
       */
      type: 'surfaceSweep';
      inputFeatureIds: [];
      args: { profile: CadSketchPath; path: CadSketchPath; orientation: 'frenet' | 'fixed' };
    })
  | (FeatureBase & {
      /**
       * R2a-2c: a sheet of one face spanning 3 or 4 curves that close a loop in order (Coons
       * patch). The face is `surface`; each boundary edge is named by the curve it comes from.
       */
      type: 'boundarySurface';
      inputFeatureIds: [];
      args: { curves: CadCurveSource[] };
    })
  | (FeatureBase & {
      /**
       * R2a-2c: a sheet of one face filling 3–16 curves that close a loop in order, touching each
       * (`G0`) or also meeting the face beside a referenced edge tangentially (`G1`).
       */
      type: 'fill';
      inputFeatureIds: [];
      args: { boundary: { curve: CadCurveSource; continuity: 'G0' | 'G1' }[] };
    })
  | (FeatureBase & {
      /**
       * R2a-3: the sheet input cut by `tool`, keeping the pieces on side `keep` (inside or
       * outside a sketch chain, front or back of a plane or sheet). The kept pieces are one sheet.
       */
      type: 'trim';
      inputFeatureIds: [string];
      args: { tool: CadTrimTool; keep: 'inside' | 'outside' | 'front' | 'back' };
    })
  | (FeatureBase & {
      /**
       * R2a-3: 2–64 sheets joined where their edges lie within `toleranceMm`
       * (0.000001–0.0001 mm) into one sheet, or into a solid when `solid` and they close.
       * The first input's body carries the result; the others are consumed.
       */
      type: 'sew';
      inputFeatureIds: [string, string, ...string[]];
      args: { toleranceMm: number; solid: boolean };
    })
  | (FeatureBase & {
      /**
       * R2a-3: a solid of the sheet input given `thickness` towards its normal (`front`), away
       * from it (`back`) or half each way (`both`).
       */
      type: 'thicken';
      inputFeatureIds: [string];
      args: { thickness: Length; side: 'front' | 'back' | 'both' };
    })
  | (FeatureBase & {
      type: 'transform';
      inputFeatureIds: [string];
      args: { translation: Position3; rotation: Quaternion };
    })
  | (FeatureBase & {
      type: 'boolean';
      /**
       * `[target, ...tools]`, 1–256 tools (docs/cad/r1-modeling.md, 詳細feature). The tools apply
       * at once; their order does not change the result or its face names.
       */
      inputFeatureIds: [string, ...string[]];
      args: { mode: 'union' | 'cut' | 'common' };
    })
  | (FeatureBase & {
      /** Constant-radius fillet of 1–256 edges of the input's output. */
      type: 'fillet';
      inputFeatureIds: [string];
      args: { edges: CadTopologyRef[]; radius: Length };
    })
  | (FeatureBase & {
      /**
       * Chamfer of 1–256 edges: one distance on both faces, or `distance` on `face` (which every
       * edge borders) and `distance2` on the other face of each edge.
       */
      type: 'chamfer';
      inputFeatureIds: [string];
      args:
        | { edges: CadTopologyRef[]; distance: Length }
        | { edges: CadTopologyRef[]; distance: Length; distance2: Length; face: CadTopologyRef };
    })
  | (FeatureBase & {
      /**
       * Hollows the input to a wall of `thickness`, on the `inside` or `outside` of its faces,
       * leaving 0–64 `openFaces` open.
       */
      type: 'shell';
      inputFeatureIds: [string];
      args: { openFaces: CadTopologyRef[]; thickness: Length; side: 'inside' | 'outside' };
    })
  | (FeatureBase & {
      /**
       * `count` copies of the tool, the first where the tool is, Booleaned into the target at
       * once (docs/cad/r1-modeling.md, 詳細feature). Copy i moves i × `spacing` along `direction`,
       * or turns i × `angle` about the axis. The tool's body is consumed.
       */
      type: 'pattern';
      inputFeatureIds: [string, string];
      args: { mode: 'union' | 'cut'; layout: CadPatternLayout | CadCurveLayout };
    })
  | (FeatureBase & {
      /**
       * The input reflected in a plane (a point and unit normal, or a planar face of the input).
       * With `union` the result is the input and its reflection together; without, the reflection
       * alone, as a new body.
       */
      type: 'mirror';
      inputFeatureIds: [string];
      args: { plane: CadMirrorPlane; union: boolean };
    })
  | (FeatureBase & {
      /**
       * Tilts 1–256 faces by `angle` (0, π/4] about where they meet the plane through the
       * `neutral` face normal to `direction` (the unit pull direction, world axes).
       */
      type: 'draft';
      inputFeatureIds: [string];
      args: { faces: CadTopologyRef[]; neutral: CadTopologyRef; angle: Angle; direction: Vec3 };
    })
  | (FeatureBase & {
      /**
       * D2: one history-less solid read from STEP, or (R2a) one sheet. The normalized BRep
       * (already in mm) is what evaluates; the source asset keeps the original bytes unchanged.
       */
      type: 'imported';
      inputFeatureIds: [];
      args: {
        /** What the file held: a `manifold_solid_brep` or a `shell_based_surface_model`. */
        kind: CadBodyKind;
        sourceAssetId: string;
        brepAssetId: string;
        /** The exact build whose reader converted the source. */
        importer: { id: string; buildHash: string };
        sourceUnit: CadLengthUnit;
        /** `cadLengthUnits[sourceUnit]`: mm per source unit, applied once by the reader. */
        scaleToMm: number;
      };
    });
export type CadFeatureType = CadFeature['type'];
/** Unit vectors in world axes. */
export type CadPatternLayout =
  | { type: 'linear'; direction: Vec3; count: Count; spacing: Length }
  | { type: 'circular'; axisOrigin: Position3; axisDirection: Vec3; count: Count; angle: Angle };
/**
 * K5a (docs/cad/complex-models.md): copies at `count` equal distances along a sketch's open chain
 * of lines and arcs, from its start (where the tool is) to its end; with `align`, each copy also
 * turned in the sketch's plane as the path's direction turns from the start.
 */
export type CadCurveLayout = { type: 'curve'; path: CadSketchPath; count: Count; align: boolean };
export type CadMirrorPlane = { origin: Position3; normal: Vec3 } | { face: CadTopologyRef };
export interface CadAppearance {
  /** `#rrggbb` sRGB. */
  color: string;
  opacity: number;
}
/**
 * R2a (docs/cad/r2a-freeform.md, Surface body): a body is one valid solid, or one sheet: one
 * connected shell of any number of faces, never treated as a solid even when closed.
 */
export type CadBodyKind = 'solid' | 'sheet';
/** `resultFeatureId` is the body's dedicated final placement transform. */
export type CadBody = {
  id: string;
  name: string;
  /** The kind its result feature gives (`featureKind`). */
  kind: CadBodyKind;
  resultFeatureId: string;
  appearance: CadAppearance;
} & ({ state: 'active' } | { state: 'consumed'; consumedByFeatureId: string });
export interface CadCamera {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}
export type CadProjection =
  | { type: 'perspective'; fovRad: number }
  | { type: 'orthographic'; spanMm: number };
export interface CadNamedView {
  id: string;
  name: string;
  bodyIds: string[];
  camera: CadCamera;
  projection: CadProjection;
}
/** Length units a STEP file may declare, as mm per unit. Anything else is refused as unknown. */
export const cadLengthUnits = Object.freeze({
  um: 0.001,
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
});
export type CadLengthUnit = keyof typeof cadLengthUnits;
/**
 * D2: an immutable byte asset the Host keeps beside the content (docs/cad/integration.md, asset
 * closure). Content only names it; bytes, URLs and paths never enter the document.
 */
export interface CadAssetRef {
  id: string;
  kind: CadAssetKind;
  /** `sha256:<hex>` of the bytes. */
  sha256: string;
  byteLength: number;
  mediaType: string;
}
export type CadAssetKind = 'source-step' | 'normalized-brep';
/** One media type per kind; the BRep is OCCT's text format (`BRepTools::Write`). */
export const cadAssetMediaTypes: Readonly<Record<CadAssetKind, string>> = Object.freeze({
  'source-step': 'model/step',
  'normalized-brep': 'model/x-occt-brep',
});
export type CadSchemaVersion = 2;
export interface CadDocument {
  schemaVersion: CadSchemaVersion;
  units: 'mm';
  axes: 'right-handed-z-up';
  kernelProfile: CadKernelProfile;
  parameters: CadParameter[];
  profiles: CadProfile[];
  /** R1d constrained sketches (docs/cad/r1-modeling.md, 拘束付きsketch（F2）). */
  sketches: CadSketch[];
  features: CadFeature[];
  bodies: CadBody[];
  namedViews: CadNamedView[];
  assets: CadAssetRef[];
  /** R2b assembly (docs/cad/r2b-assembly.md): BOM values when used as a part, and placed parts. */
  partProperties: CadPartProperties;
  parts: CadPartDef[];
  components: CadComponent[];
  componentPatterns: CadComponentPattern[];
  joints: CadJoint[];
  /** Last solved pose of every component, by component ID (R2b-U5). */
  solvedPoses: Record<string, CadSolvedPose>;
}
export interface CadDiagnostic {
  code: string;
  path: string;
  severity: 'error' | 'warning';
  /** `duplicate-id`: the ID and the path that used it first. */
  id?: string;
  firstPath?: string;
  /** `cad-dependency-cycle`: the feature and sketch IDs on the cycle, in dependency order. */
  nodes?: string[];
}

/** Initial safety limits (model.md). Not performance claims. */
export const cadLimits = Object.freeze({
  coordinateMm: 1_000_000,
  minDimensionMm: 0.001,
  maxDimensionMm: 1_000_000,
  affineScale: 1_000_000,
  /** Active bodies (docs/cad/complex-models.md, CM-U3); consumed tools count only in `allBodies`. */
  bodies: 64,
  allBodies: 1_024,
  /**
   * Solids of one solid body, and of all active bodies (docs/cad/complex-models.md, K1): the
   * disjoint solids a Boolean, a pattern or a mirror's union leaves.
   */
  solidsPerBody: 1_024,
  solids: 4_096,
  features: 256,
  profiles: 64,
  parameters: 512,
  namedViews: 16,
  verticesPerProfile: 256,
  vertices: 4_096,
  dagDepth: 128,
  idCodePoints: 128,
  nameCodePoints: 256,
  contentBytes: 4 * 1024 * 1024,
  jsonDepth: 32,
  /** D2 asset limits per document (model.md); the Host's total admission comes first. */
  assets: 128,
  stepBytes: 16 * 1024 * 1024,
  brepBytes: 32 * 1024 * 1024,
  assetBytes: 64 * 1024 * 1024,
});
/** Tools one Boolean applies at once (docs/cad/r1-modeling.md, 上限). */
export const cadBooleanTools = 256;
/** Faces one shell leaves open (docs/cad/r1-modeling.md, 詳細feature). */
export const cadShellOpenFaces = 64;
/** Sections of one loft (docs/cad/r1-modeling.md, 上限). */
export const cadLoftSections = 32;
/** Curves of a boundary surface and of a fill (docs/cad/r2a-freeform.md, 上限). */
export const cadBoundaryCurves = Object.freeze({ surface: [3, 4], fill: [3, 16] } as const);
/** Sheets one sew joins, and its joining distance in mm (docs/cad/r2a-freeform.md, 上限). */
export const cadSewInputs = 64;
export const cadSewToleranceMm = Object.freeze([0.000001, 0.0001] as const);
/** Pattern copies in the whole document (docs/cad/r1-modeling.md, 上限). */
export const cadPatternCopies = 4096;
export const quaternionNormTolerance = 1e-9;
/** The `standard` tolerance set of semanticsVersion 2; never relaxed automatically. */
export const cadTolerance = Object.freeze({
  linearToleranceMm: 0.000001,
  angularToleranceRad: 0.000000001,
  maxResultLinearToleranceMm: 0.0001,
});
/**
 * The named tolerance sets a document chooses from (docs/cad/complex-models.md, K2, CM-U2):
 * `standard`, and `large` for assemblies tens of metres long. Chosen when a document is made or
 * by an explicit edit, never because an evaluation failed.
 */
export const cadToleranceSets = Object.freeze({
  standard: cadTolerance,
  large: Object.freeze({
    linearToleranceMm: 0.00001,
    angularToleranceRad: 0.000000001,
    maxResultLinearToleranceMm: 0.01,
  }),
});
export type CadToleranceSet = keyof typeof cadToleranceSets;
/** The set whose values `profile` has, or undefined for values no set has. */
export function cadToleranceSetOf(
  profile: Pick<
    CadKernelProfile,
    'linearToleranceMm' | 'angularToleranceRad' | 'maxResultLinearToleranceMm'
  >,
): CadToleranceSet | undefined {
  return (Object.keys(cadToleranceSets) as CadToleranceSet[]).find((name) =>
    Object.entries(cadToleranceSets[name]).every(
      ([key, value]) => profile[key as keyof typeof profile] === value,
    ),
  );
}

export const identityQuaternion = (): Quaternion => [0, 0, 0, 1];
export const mm = (literalMm: number): Length => ({ literalMm });
export const position = (x: number, y: number, z: number): Position3 => [mm(x), mm(y), mm(z)];
export const emptyCad = (kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>): CadDocument => ({
  schemaVersion: 2,
  units: 'mm',
  axes: 'right-handed-z-up',
  kernelProfile: {
    id: kernel.id,
    buildHash: kernel.buildHash,
    semanticsVersion: 2,
    ...cadTolerance,
  },
  parameters: [],
  profiles: [],
  sketches: [],
  features: [],
  bodies: [],
  namedViews: [],
  assets: [],
  partProperties: { partNumber: '', description: '' },
  parts: [],
  components: [],
  componentPatterns: [],
  joints: [],
  solvedPoses: {},
});
