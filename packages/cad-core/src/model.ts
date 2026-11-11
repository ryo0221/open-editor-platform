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
import type {
  GeometryEmission,
  GeometryNormalConvention,
  GeometryTextureRole,
} from '@editor-platform/geometry-core';
import type { CadConfiguration } from './configurations';
import type { CadMount } from './mounts';
import type { CadGearMesh } from './gear-mesh';
import type { CadInterferenceAllowance } from './interference';
import type { CadExpression, CadParameterType } from './expression';
import type { CadSketch, CadSketchRegion } from './sketch';
import type { CadTopologyRef } from './topology';
import type { CadProfileKind } from './profile-section';
import type { CadSpurGearArgs } from './gear';

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
      /** WM1a (docs/cad/watch-design.md): an external involute spur gear (`gear.ts`). */
      type: 'spurGear';
      inputFeatureIds: [];
      args: CadSpurGearArgs;
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
       * CR4d: a sheet: a section of a kind (`profile-section.ts`: hat, Z, channel or flat, by its
       * dimensions) carried along `path` (an open chain). Its height points along the path
       * sketch's normal (`normal`), across the path in the sketch's plane (`inPlane`), or along
       * a unit vector square to a straight path; `flip` turns it the other way.
       */
      type: 'profileSweep';
      inputFeatureIds: [];
      args: {
        path: CadSketchPath;
        profile: {
          kind: CadProfileKind;
          height: Length;
          width: Length;
          flange: Length;
          radius: Length;
        };
        up: 'normal' | 'inPlane' | Vec3;
        flip: boolean;
      };
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
       * CR1d (docs/cad/car-design.md, CR1の分け方): a sheet of one face through a network of
       * curves (Gordon surface): 2–16 `u` curves (e.g. sections) crossed by 2–16 `v` curves (e.g.
       * character lines), each pair meeting within `toleranceMm`. The face is `surface`; its
       * boundary edges are named by the first and last curves of each way.
       */
      type: 'curveNetwork';
      inputFeatureIds: [];
      args: { u: CadCurveSource[]; v: CadCurveSource[]; toleranceMm: number };
    })
  | (FeatureBase & {
      /**
       * CR2b: another sheet's result moved `distance` (0.01–100 mm) along its normal (`front`) or
       * against it (`back`), as a new sheet: an inner panel, a glass or a lamp's outer lens. The
       * source is read, never consumed.
       */
      type: 'offsetSurface';
      inputFeatureIds: [];
      args: { source: { featureId: string }; distance: Length; side: 'front' | 'back' };
    })
  | (FeatureBase & {
      /**
       * R2a-2c: a sheet of one face filling 3–16 curves that close a loop in order, touching each
       * (`G0`) or also meeting the face beside a referenced edge tangentially (`G1`).
       */
      type: 'fill';
      inputFeatureIds: [];
      args: { boundary: { curve: CadCurveSource; continuity: 'G0' | 'G1' | 'G2' }[] };
    })
  | (FeatureBase & {
      /**
       * R2a-3: the sheet input cut by `tool`, keeping the pieces on side `keep` (inside or
       * outside a sketch chain, front or back of a plane or sheet). The kept pieces are one sheet.
       */
      type: 'trim';
      inputFeatureIds: [string];
      args: {
        tool: CadTrimTool;
        keep: 'inside' | 'outside' | 'front' | 'back';
        /**
         * CR3b: with a sketch chain, the cut runs `gap / 2` (0.5–10 mm gaps) off the chain into
         * the kept side, the chain offset in its plane (`sketchOffset`): a panel's gap.
         */
        gap?: Length;
        /**
         * CR3c: more closed chains of the tool's sketch, cut at once with its own chain (a row of
         * windows). `inside` keeps what any chain holds, `outside` what none holds.
         */
        chains?: string[][];
        /**
         * CR3c: a sketch chain that cuts nothing is refused (`trim-no-cut`, naming the chain), or
         * with `skip` left out of the cut, as long as one chain still cuts.
         */
        ifMissed?: 'skip';
      };
    })
  | (FeatureBase & {
      /**
       * CR3b: a panel cut out of another sheet's result along a sketch's closed chain: the
       * pieces `inside` (or `outside`) the chain moved `gap / 2` into them, as a new sheet. The
       * source is read, never consumed; a `trim` of the source with the same chain, the other
       * side kept and the same gap, leaves the gap between them.
       */
      type: 'panel';
      inputFeatureIds: [];
      args: {
        source: { featureId: string };
        tool: CadSketchPath;
        keep: 'inside' | 'outside';
        gap: Length;
      };
    })
  | (FeatureBase & {
      /**
       * CR2a: a sheet's faces divided along a sketch's chain carried along the sketch's normal,
       * every piece kept: `left`/`right` of an open chain (looking down the normal), `inside`/
       * `outside` of a closed one. The dividing edges are named by the chain's elements.
       */
      type: 'split';
      inputFeatureIds: [string];
      args: { tool: CadSketchPath };
    })
  | (FeatureBase & {
      /**
       * CR6d: a round groove (a seat's stitch line, a tyre's tread) cut into a solid: the chain a
       * sketch draws is projected along the sketch's normal onto the solid's nearest faces, and a
       * tube of `radius` (0.1–10 mm) swept along it is cut away, so the groove is a half round
       * `radius` deep and twice as wide.
       */
      type: 'groove';
      inputFeatureIds: [string];
      args: { tool: CadSketchPath; radius: Length };
    })
  | (FeatureBase & {
      /**
       * CR2c: a press line. The sheet is divided along a sketch's chain (as `split`), the pieces on
       * `side` moved `depth` (0.1–20 mm) along their normal (`front`) or against it (`back`), a
       * wall run between the two edges of the line, and both edges of the wall rounded by
       * `radius`.
       */
      type: 'pressLine';
      inputFeatureIds: [string];
      args: {
        tool: CadSketchPath;
        side: 'left' | 'right' | 'inside' | 'outside';
        depth: Length;
        toward: 'front' | 'back';
        radius: Length;
      };
    })
  | (FeatureBase & {
      /**
       * CR2d: a flare. The sheet is divided along a sketch's open chain (as `split`); the pieces
       * on the side of `arch` (a free edge of the sheet, a wheel arch) are replaced by a fill
       * whose arch is moved `height` (1–100 mm) out along their normal, meeting the pieces that
       * stay G1 or G2 along the chain.
       */
      type: 'flare';
      inputFeatureIds: [string];
      args: {
        tool: CadSketchPath;
        arch: CadTopologyRef;
        height: Length;
        continuity: 'G1' | 'G2';
      };
    })
  | (FeatureBase & {
      /**
       * CR4c: a flange. Along each of 1–256 free edges of the sheet, a strip `width` (1–200 mm)
       * wide leaves the edge at `angle` (0–180°) from the sheet's tangent plane, turning to its
       * `toward` side (90° is square to the sheet), its ends square to the edge; the strips are
       * joined to the sheet as one body.
       */
      type: 'flange';
      inputFeatureIds: [string];
      args: {
        edges: CadTopologyRef[];
        width: Length;
        angle: Angle;
        toward: 'front' | 'back';
      };
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
      /**
       * Fillet of 1–256 edges of the input's output: a solid's edges, or (CR1e) a sheet's edges
       * between two of its faces. `radius` alone is constant. With `radiusEnd` the radius runs
       * from `radius` at each edge's start to `radiusEnd` at its end, linearly, or through `radii`
       * between (1–6 points, `at` in (0, 1) along the edge, increasing): 2–8 radii in all.
       */
      type: 'fillet';
      inputFeatureIds: [string];
      args: {
        edges: CadTopologyRef[];
        radius: Length;
        radiusEnd?: Length;
        radii?: { at: number; radius: Length }[];
      };
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
       * CR4b (docs/cad/car-design.md): the reflection of feature `source` (a sheet or a solid) in a
       * plane (a point and unit normal), as a new body. Like `offsetSurface`, it reads the source
       * without consuming it, so a left part and its right copy are two bodies of one feature.
       */
      type: 'mirrorCopy';
      inputFeatureIds: [];
      args: { source: { featureId: string }; plane: { origin: Position3; normal: Vec3 } };
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
        /**
         * #820: the largest tolerance the reader found, recorded when it is above the standard
         * result limit (`cadTolerance`), up to `cadImportToleranceMm`. The shape is kept as read
         * (no healing): its body can be placed, measured and exported, but no feature takes it
         * as input while this is above the document's result limit (`input-tolerance`).
         */
        maxToleranceMm?: number;
        /**
         * PMI-2: the `pmi` asset of the semantic PMI the import kept for this body (targets are
         * sub-shapes of the BRep). Absent when the file had none or none was kept.
         */
        pmiAssetId?: string;
      };
    });
export type CadFeatureType = CadFeature['type'];
/** Unit vectors in world axes. */
export type CadPatternLayout =
  | {
      type: 'linear';
      direction: Vec3;
      count: Count;
      spacing: Length;
      /**
       * CR6d: the row repeated `count` times `spacing` apart along a second direction, a grid of
       * copies (a lamp lens's cuts). Copy `row × count + i` is copy i of row `row`.
       */
      rows?: { direction: Vec3; count: Count; spacing: Length };
    }
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
  /**
   * #661: the finish (glTF metal/roughness, each 0–1). Absent: the default finish
   * (`geometryDefaultFinish`), as bodies were drawn before materials.
   */
  roughness?: number;
  metalness?: number;
  /** #661: the library preset these values were copied from (`geometryMaterialPresets`). */
  material?: string;
  /**
   * CR6a (docs/cad/car-design.md): the light the surface gives off (a lamp), and how much light
   * passes through it with its index of refraction (a clear lens). Absent: none, opaque, 1.5.
   */
  emission?: GeometryEmission;
  transmission?: number;
  ior?: number;
  /**
   * #662: image maps over the look, each a texture asset of the content. As in glTF, the
   * colour, roughness and metalness multiply the maps.
   */
  textures?: CadTextures;
}
/** #662: a texture set on a body, as the user read it from downloaded image files. */
export interface CadTextures {
  /** Asset IDs (`texture-png` / `texture-jpeg`) by map; at least one. */
  maps: Partial<Record<GeometryTextureRole, string>>;
  /** The size one image covers on a face (mm): width, height. */
  sizeMm: [number, number];
  /** Turn of the image on the face, counter-clockwise (degrees, −360 to 360). */
  rotationDeg: number;
  /** The normal map's convention: a DirectX map is drawn with its green flipped. */
  normal: GeometryNormalConvention;
  /** The set's name (e.g. the downloaded file's). */
  name: string;
  /** Where it was downloaded from (`http(s)://`) and its licence, as the user gave them. */
  source?: string;
  license?: string;
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
/** CR4e: one face of a body's final shape, a flange a spot weld joins. */
export interface CadSpotWeldFlange {
  bodyId: string;
  /** A face of the body's final shape, made on one of its features (resolved on the final). */
  face: CadTopologyRef;
}
/**
 * CR4e (docs/cad/car-design.md, W3): a row of spot welds along two overlapping flanges. Not a
 * feature: it changes no shape, and its points are made again from the flanges at each
 * evaluation, `pitchMm` apart along the first flange's centre line and at least
 * `endDistanceMm` from its ends. A point further than `maxGapMm` from either flange is counted
 * as too far. CR5 turns the points into the analysis's joints.
 */
export interface CadSpotWeld {
  id: string;
  name: string;
  flanges: [CadSpotWeldFlange, CadSpotWeldFlange];
  pitchMm: number;
  endDistanceMm: number;
  /** The largest distance from a point to either flange (default: two 0.8 mm sheets + 0.5 mm). */
  maxGapMm: number;
}
/** CR4e: limits and defaults of spot welds (docs/cad/r2a-freeform.md, CR4e). */
export const cadSpotWeldLimits = Object.freeze({
  spotWelds: 256,
  pitchMm: [10, 200] as const,
  defaultPitchMm: 40,
  endDistanceMm: [0, 100] as const,
  defaultEndDistanceMm: 10,
  maxGapMm: [0.1, 20] as const,
  defaultMaxGapMm: 2.1,
  /** Points of one row, and of all rows of a document. */
  pointsPerWeld: 1_000,
  points: 8_000,
});
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
/** #662: a texture image is a PNG or a JPEG asset, one kind each. */
/** PMI-2: `pmi` is the semantic PMI an import kept (`CadPmiAsset`, docs/cad/pmi.md). */
export type CadAssetKind =
  | 'source-step'
  | 'normalized-brep'
  | 'pmi'
  /** PMI-5: an assembly's PMI of particular instances (`CadPmiAsset`, targets with `component`). */
  | 'assembly-pmi'
  | 'texture-png'
  | 'texture-jpeg';
/** One media type per kind; the BRep is OCCT's text format (`BRepTools::Write`). */
export const cadAssetMediaTypes: Readonly<Record<CadAssetKind, string>> = Object.freeze({
  'source-step': 'model/step',
  'normalized-brep': 'model/x-occt-brep',
  pmi: 'application/json',
  'assembly-pmi': 'application/json',
  'texture-png': 'image/png',
  'texture-jpeg': 'image/jpeg',
});
/** The texture asset kind of an image media type. */
export const cadTextureKind = (mediaType: string): CadAssetKind | undefined =>
  mediaType === 'image/png'
    ? 'texture-png'
    : mediaType === 'image/jpeg'
      ? 'texture-jpeg'
      : undefined;
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
  /**
   * PMI-5 (docs/cad/pmi.md, 組立経路の参照): the `assembly-pmi` asset with the PMI a STEP file
   * gave particular instances through assembly paths. Only in an assembly.
   */
  assemblyPmiAssetId?: string;
  /** CR4e: spot welds between bodies' flanges (none when absent). */
  spotWelds?: CadSpotWeld[];
  /** MR2 (docs/cad/mecha-design.md): named sets of joint values, 1–32 when present. */
  configurations?: CadConfiguration[];
  /** MR3 (docs/cad/mecha-design.md): explicit interference allowances, 1–256 when present. */
  interferenceAllowances?: CadInterferenceAllowance[];
  /** MR7 (docs/cad/mecha-design.md): components with candidate joints, 1–64 when present. */
  mounts?: CadMount[];
  /** WM2 (docs/cad/watch-design.md): spur gears in mesh, 1–256 when present. */
  gearMeshes?: CadGearMesh[];
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
  /**
   * ±10 km (#589): civil works (a long bridge, a river reach) in mm. Display meshes are 32-bit
   * floats, about 1 mm apart at this distance from the origin; further needs a coarser unit.
   */
  coordinateMm: 10_000_000,
  minDimensionMm: 0.001,
  maxDimensionMm: 10_000_000,
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
  /**
   * WM5c (docs/cad/watch-design.md): an assembly written as STEP AP242. Larger than what is read
   * (`stepBytes`): a watch's 17 parts with their gears write about 16 MiB, so the written file
   * may not be read back here.
   */
  stepExportBytes: 64 * 1024 * 1024,
  brepBytes: 32 * 1024 * 1024,
  assetBytes: 64 * 1024 * 1024,
});
/** Tools one Boolean applies at once (docs/cad/r1-modeling.md, 上限). */
export const cadBooleanTools = 256;
/** Faces one shell leaves open (docs/cad/r1-modeling.md, 詳細feature). */
export const cadShellOpenFaces = 64;
/** CR1e: radii a varying fillet gives along an edge, its two ends included. */
export const cadFilletRadii = [2, 8] as const;
/** CR2b: the largest offset of a surface (mm). */
export const cadOffsetSurfaceMaxMm = 100;
/** CR3b: a panel's gap (mm), and the gap a new panel takes. */
export const cadPanelGapMm = [0.5, 10] as const;
export const cadPanelGapDefaultMm = 3.5;
/** CR3c: the most closed chains one trim cuts at once (its tool's chain and `chains`). */
export const cadTrimChains = 32;
/** CR2d: a flare's height (mm). */
export const cadFlareHeightMm = [1, 100] as const;
/** CR2d: profiles across a flare's fill, the ramps included (a Gordon surface's v-curves). */
export const cadFlareProfiles = 32;
/** CR4c: a flange's width (mm). */
export const cadFlangeWidthMm = [1, 200] as const;
/** CR2c: a press line's depth (mm). */
export const cadPressLineDepthMm = [0.1, 20] as const;
/** CR6d: a groove's radius (mm). */
export const cadGrooveRadiusMm = [0.1, 10] as const;
/** Sections of one loft (docs/cad/r1-modeling.md, 上限). */
export const cadLoftSections = 32;
/** Curves of a boundary surface and of a fill (docs/cad/r2a-freeform.md, 上限). */
export const cadBoundaryCurves = Object.freeze({ surface: [3, 4], fill: [3, 16] } as const);
/** CR1d: curves each way of a curve network, and the meeting tolerance (mm). */
export const cadCurveNetwork = Object.freeze({
  curves: [2, 16] as const,
  toleranceMm: [0.0001, 1] as const,
});
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
 * #820: the largest shape tolerance a STEP import keeps as read (mm). Shapes from other CAD
 * systems carry their own precision (0.001–0.1 mm is common); above this the import refuses.
 */
export const cadImportToleranceMm = 1;
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
