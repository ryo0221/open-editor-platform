import type { Easing, Rational } from '@editor-platform/animation-core';
import type { GeometryTextureRole } from '@editor-platform/geometry-core';

/** x, y, z (mm for positions). */
export type Vec3 = [number, number, number];
/** A unit quaternion x, y, z, w. */
export type Quat = [number, number, number, number];
/** Translation (mm), then rotation, then scale: M = T · R · S. */
export interface Transform3 {
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/**
 * An immutable byte asset the Host keeps beside the content (ADR 019). Content only names it;
 * bytes, URLs and paths never enter the document.
 */
export interface CharacterAssetRef {
  id: string;
  kind: CharacterAssetKind;
  /** `sha256:<hex>` of the bytes. */
  sha256: string;
  byteLength: number;
  mediaType: string;
}
export type CharacterAssetKind = 'mesh-epm' | 'mesh-mres' | 'texture-png' | 'texture-jpeg';
export const characterAssetMediaTypes: Readonly<Record<CharacterAssetKind, string>> = Object.freeze(
  {
    'mesh-epm': 'model/x-editor-platform-mesh',
    'mesh-mres': 'model/x-editor-platform-multires',
    'texture-png': 'image/png',
    'texture-jpeg': 'image/jpeg',
  },
);

/** A glTF-style metal/roughness material; maps name texture assets of the content. */
export interface CharacterMaterial {
  id: string;
  name: string;
  /** `#rrggbb` sRGB. */
  color: string;
  opacity: number;
  roughness: number;
  metalness: number;
  maps: Partial<Record<GeometryTextureRole, string>>;
  doubleSided: boolean;
}

/** One mesh object. Its geometry is the `mesh` asset; `materials` fills its material slots. */
export interface CharacterPart {
  id: string;
  name: string;
  parentId: string | null;
  transform: Transform3;
  /** A `mesh-epm` asset ID. */
  mesh: string;
  /** Material IDs by slot; a face's slot indexes this list. */
  materials: string[];
  visible: boolean;
  /**
   * C3: Catmull-Clark levels shown while editing and when rendering (0–4). Absent means none; the
   * asset stays the cage either way.
   */
  subdivision?: CharacterSubdivision;
  /**
   * C7a: sculpted detail on the cage subdivided `level` times (geometry-mesh's multires). The
   * cage asset stays the low-poly mesh that is skinned and exported.
   */
  multires?: CharacterMultires;
}
/**
 * A part's multires: the displacement of every corner grid at `level`, in `mesh-mres` chunk
 * assets in corner order, made for the cage faces whose hash is `topology`.
 */
export interface CharacterMultires {
  level: number;
  /** `multiresTopology` of the part's mesh: an edit that changes its faces is refused. */
  topology: string;
  chunks: string[];
}
export interface CharacterSubdivision {
  levels: number;
  renderLevels: number;
}
export interface CharacterBone {
  id: string;
  name: string;
  parentId: string | null;
  /** The rest pose, relative to the parent bone (or to the skeleton). */
  rest: Transform3;
  /**
   * C5d: how far IK may turn the bone, as XYZ Euler degrees of its local rotation (−180…180,
   * min ≤ max). Keys are not clamped: only the IK solution is.
   */
  limits?: { min: Vec3; max: Vec3 };
}
/**
 * C5d: an IK chain. The tip bone's head reaches for `target` by turning the `length` bones above
 * it (2: an arm or a leg, solved exactly; more by FABRIK). The chain bends toward `pole` when
 * given. Solved when the pose is evaluated, after the keys; the rest pose is never solved.
 */
export interface CharacterIkChain {
  id: string;
  name: string;
  tipBoneId: string;
  length: number;
  /** Character space, mm. */
  target: Vec3;
  /** Character space, mm, or null. */
  pole: Vec3 | null;
  enabled: boolean;
}
export interface CharacterSkeleton {
  id: string;
  name: string;
  /** The part the skeleton's root sits in, or null for the character's origin. */
  parentPartId: string | null;
  bones: CharacterBone[];
  /** C5d: IK chains, solved in order. Absent means none. */
  ik?: CharacterIkChain[];
}
/**
 * Binds a part's mesh to a skeleton: every bone its weights name has an inverse bind matrix. As in
 * glTF, a skinned vertex follows its bones only: in character space it is the weighted sum of
 * world(bone) · inverseBind · position, and the part's own transform does not move it.
 */
export interface CharacterSkin {
  id: string;
  partId: string;
  skeletonId: string;
  /** Column-major 4×4, from the part's mesh space to the bone's at bind, per weighted bone. */
  inverseBind: { boneId: string; matrix: number[] }[];
}
/** A morph target of a part; its deltas are in the part's mesh asset under the same ID. */
export interface CharacterMorph {
  id: string;
  partId: string;
  name: string;
  /** The weight when no action drives it. */
  weight: number;
}

/**
 * A value a CAD joint reads: radians for an angle (`angle`, and `angle2`/`angle3` of the MR1
 * spherical and universal joints), millimetres otherwise (cad-core's keys).
 */
export type CharacterJointValueKey = 'angle' | 'angle2' | 'angle3' | 'distance' | 'u' | 'v';
export const isCharacterJointAngle = (key: CharacterJointValueKey) =>
  key === 'angle' || key === 'angle2' || key === 'angle3';
export const characterJointValueKeys: readonly CharacterJointValueKey[] = Object.freeze([
  'angle',
  'angle2',
  'angle3',
  'distance',
  'u',
  'v',
]);
/**
 * A CAD (C2b) or BIM (C8p) version shown with the character: fixed by version and content hash, as
 * a building places a part. Its shape is the Host's to evaluate; the document never holds it.
 */
export interface CharacterProp {
  id: string;
  name: string;
  /** C8p: a BIM version (a building) too; its elements do not move, so it has no joints. */
  source: { kind: 'cad' | 'bim'; artifactId: string; versionId: string; contentHash: string };
  /** Where the version's origin sits in the character's space (no scale: CAD is in mm too). */
  placement: { translation: Vec3; rotation: Quat };
  visible: boolean;
}

export type CharacterTrackTarget =
  | { kind: 'part'; id: string; property: 'translation' | 'rotation' | 'scale' }
  | { kind: 'bone'; id: string; property: 'translation' | 'rotation' | 'scale' }
  | { kind: 'morph'; id: string; property: 'weight' }
  /**
   * One value of a joint of a prop's assembly (`joint` is the CAD joint ID). The version is not
   * read here, so a joint it does not have is reported by the Host when it is shown.
   */
  | { kind: 'prop-joint'; id: string; joint: string; property: CharacterJointValueKey }
  /** MR4: a prop's placement (flying, landing), interpolated as a part's (rotation slerped). */
  | { kind: 'prop'; id: string; property: 'translation' | 'rotation' }
  /**
   * MR7: which candidate joint of a prop's mount (`mount` is the CAD mount ID) places its part.
   * Keys hold a joint ID with `hold` easing: each from its tick until the next. Before the first
   * key the version's own choice holds. The version is not read here, like `prop-joint`.
   */
  | { kind: 'prop-mount'; id: string; mount: string; property: 'joint' }
  /**
   * CR7e: the action's camera (one per action): where it stands and the point it looks at, in
   * the character's space (mm), Vec3 keys interpolated as a translation. The lens and the up
   * axis (+Z) are the view's. Playback and the video export look through it; without these
   * tracks the view's own camera is used, as before.
   */
  | { kind: 'camera'; property: 'position' | 'target' };
/** What a key holds: a string only in a `prop-mount` track (MR7). */
export type CharacterKeyValue = number | Vec3 | Quat | string;
export interface CharacterKey {
  id: string;
  tick: number;
  /**
   * Vec3 for translation and scale, Quat for rotation, a number for a morph weight or a joint
   * value, a joint ID for a `prop-mount` track (MR7) only.
   */
  value: CharacterKeyValue;
  /** From this key to the next, as in Animation (ADR 012). Rotation is slerped. */
  easing: Easing;
}
export interface CharacterTrack {
  id: string;
  target: CharacterTrackTarget;
  keys: CharacterKey[];
}
export interface CharacterAction {
  id: string;
  name: string;
  /** Ticks (240,000 per second); keys lie in [0, duration]. */
  duration: number;
  frameRate: Rational;
  tracks: CharacterTrack[];
}

export type CharacterSchemaVersion = 1;
export interface CharacterDocument {
  schemaVersion: CharacterSchemaVersion;
  units: 'mm';
  axes: 'right-handed-z-up';
  ticksPerSecond: 240000;
  name: string;
  assets: CharacterAssetRef[];
  materials: CharacterMaterial[];
  parts: CharacterPart[];
  skeletons: CharacterSkeleton[];
  skins: CharacterSkin[];
  morphs: CharacterMorph[];
  props: CharacterProp[];
  actions: CharacterAction[];
  /**
   * IDs of removed parts, skins, morphs, props, actions and tracks: never given to a new element
   * of this document (an element ID keeps meaning one element across versions). Absent when
   * nothing was removed.
   */
  retiredIds?: string[];
}

/** The initial safety limits of the design (docs/character/README.md); reviewed before acceptance. */
export const characterLimits = Object.freeze({
  idCodePoints: 128,
  nameCodePoints: 256,
  /** C7a: raised from 1,024, since a multires is one asset per chunk. */
  assets: 4096,
  materials: 256,
  parts: 256,
  materialSlots: 64,
  skeletons: 16,
  bones: 512,
  /** C5d: IK chains per skeleton, and bones turned by one chain. */
  ikChains: 32,
  ikChainLength: 32,
  morphs: 256,
  /** A morph weight, with or without an action (C6a keys too). */
  morphWeight: 10,
  props: 64,
  retiredIds: 65_536,
  /** The largest joint distance a key may hold, in mm (a kilometre). */
  jointTravelMm: 1_000_000,
  /**
   * CR7e: how far from the origin a camera key may stand or look, in mm. GV2c: 10 km, so a shot
   * can take in a whole flying island (7.2 km across, rising 6.4 km). The view's far plane
   * follows the scene's size, not this bound.
   */
  cameraRangeMm: 10_000_000,
  /**
   * WM2: the largest joint angle a key may hold, in radians: a CAD continuous joint's bound
   * (`cadJointLimits.continuousRad`). A joint that keeps one turn bounds its keys by the limits
   * its version gives (`CharacterPropJointValue.min`/`max`).
   */
  jointTurnRad: 1_000_000,
  actions: 512,
  tracksPerAction: 4096,
  keysPerTrack: 100_000,
  /** One hour of ticks. */
  durationTicks: 240_000 * 3600,
  contentBytes: 32 * 1024 * 1024,
  jsonDepth: 16,
  assetBytes: 64 * 1024 * 1024,
  /** C3: subdivision levels of a part (geometry-mesh's `subdivisionLimits.levels`). */
  subdivisionLevels: 4,
  /** C7a: multires levels, and top-level vertices in one part and in the whole document. */
  multiresLevels: 7,
  multiresVertices: 2_100_000,
  multiresDocumentVertices: 4_200_000,
  /** C3: the distinct asset bytes the Undo history may keep before its oldest entries go. */
  historyAssetBytes: 512 * 1024 * 1024,
});
export const characterTolerance = Object.freeze({ unitQuaternion: 1e-4, bindMatrix: 1e-3 });

export interface CharacterDiagnostic {
  code: string;
  path: string;
  message: string;
}
export class CharacterValidationError extends Error {
  constructor(readonly diagnostics: CharacterDiagnostic[]) {
    super(diagnostics.map((d) => `${d.code} ${d.path}`).join('; '));
    this.name = 'CharacterValidationError';
  }
}

export const identityTransform = (): Transform3 => ({
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});
export function emptyCharacter(name = 'Character'): CharacterDocument {
  return {
    schemaVersion: 1,
    units: 'mm',
    axes: 'right-handed-z-up',
    ticksPerSecond: 240000,
    name,
    assets: [],
    materials: [],
    parts: [],
    skeletons: [],
    skins: [],
    morphs: [],
    props: [],
    actions: [],
  };
}
