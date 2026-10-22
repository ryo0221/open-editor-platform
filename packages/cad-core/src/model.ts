/** CAD schema 1 (docs/cad/model.md). Pure data: no functions, typed arrays, URLs or Wasm handles. */
export type Length =
  | { literalMm: number }
  | { parameterId: string }
  | { affine: { parameterId: string; scale: number; offsetMm: number } };
export type Angle = { literalRad: number } | { parameterId: string };
export type Position3 = [Length, Length, Length];
/** Unit quaternion `[x, y, z, w]`; `|norm - 1| <= quaternionNormTolerance`. */
export type Quaternion = [number, number, number, number];
export type Vec3 = [number, number, number];

export interface CadKernelProfile {
  id: string;
  /** Exact evaluator identity (`sha256:<hex>`), pinned by the kernel gate. */
  buildHash: string;
  semanticsVersion: 1;
  linearToleranceMm: number;
  angularToleranceRad: number;
  maxResultLinearToleranceMm: number;
}
export interface CadParameter {
  id: string;
  name: string;
  type: 'length' | 'angle';
  /** mm for length, rad for angle. Parameters are literals only in schema 1. */
  value: number;
}
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
      args: { profileId: string; distance: Length; direction: 1 | -1 };
    })
  | (FeatureBase & {
      type: 'revolve';
      inputFeatureIds: [];
      /** Axis origin in plane u/v; direction is a unit u/v vector. */
      args: {
        profileId: string;
        axisOrigin: [Length, Length];
        axisDirection: [number, number];
        angle: Angle;
      };
    })
  | (FeatureBase & {
      type: 'transform';
      inputFeatureIds: [string];
      args: { translation: Position3; rotation: Quaternion };
    })
  | (FeatureBase & {
      type: 'boolean';
      /** Ordered `[target, tool]`. */
      inputFeatureIds: [string, string];
      args: { mode: 'union' | 'cut' | 'common' };
    });
export type CadFeatureType = CadFeature['type'];
export interface CadAppearance {
  /** `#rrggbb` sRGB. */
  color: string;
  opacity: number;
}
/** `resultFeatureId` is the body's dedicated final placement transform. */
export type CadBody = {
  id: string;
  name: string;
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
/** D2 only. Schema 1 documents accepted by D1 keep `assets` empty. */
export interface CadAssetRef {
  id: string;
  kind: 'source-step' | 'normalized-brep';
  sha256: string;
  byteLength: number;
  mediaType: string;
}
export interface CadDocument {
  schemaVersion: 1;
  units: 'mm';
  axes: 'right-handed-z-up';
  kernelProfile: CadKernelProfile;
  parameters: CadParameter[];
  profiles: CadProfile[];
  features: CadFeature[];
  bodies: CadBody[];
  namedViews: CadNamedView[];
  assets: CadAssetRef[];
}
export interface CadDiagnostic {
  code: string;
  path: string;
  severity: 'error' | 'warning';
}

/** Initial safety limits (model.md). Not performance claims. */
export const cadLimits = Object.freeze({
  coordinateMm: 1_000_000,
  minDimensionMm: 0.001,
  maxDimensionMm: 1_000_000,
  affineScale: 1_000_000,
  bodies: 64,
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
});
export const quaternionNormTolerance = 1e-9;
/** The only tolerance set defined for semanticsVersion 1; never relaxed automatically. */
export const cadToleranceV1 = Object.freeze({
  linearToleranceMm: 0.000001,
  angularToleranceRad: 0.000000001,
  maxResultLinearToleranceMm: 0.0001,
});

export const identityQuaternion = (): Quaternion => [0, 0, 0, 1];
export const mm = (literalMm: number): Length => ({ literalMm });
export const position = (x: number, y: number, z: number): Position3 => [mm(x), mm(y), mm(z)];
export const emptyCad = (kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>): CadDocument => ({
  schemaVersion: 1,
  units: 'mm',
  axes: 'right-handed-z-up',
  kernelProfile: {
    id: kernel.id,
    buildHash: kernel.buildHash,
    semanticsVersion: 1,
    ...cadToleranceV1,
  },
  parameters: [],
  profiles: [],
  features: [],
  bodies: [],
  namedViews: [],
  assets: [],
});
