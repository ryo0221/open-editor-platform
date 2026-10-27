import type { Vec3 } from '@editor-platform/bim-core';

/**
 * Where a building's parts come from (docs/cad/r2c-architecture.md, version reference; R2c-U2):
 * the Host's saved CAD versions. The building never reads a CAD document; it names the exact
 * version and asks the Host for its evaluated shape, a normalized BRep, made with the Host's
 * kernel build. The bim package never imports CAD (ADR 017).
 */
export interface BimPartVersion {
  versionId: string;
  label: string;
  contentHash: string;
}
export interface BimPartCandidate {
  artifactId: string;
  name: string;
  /** Newest first. */
  versions: BimPartVersion[];
}
export interface BimPartReference {
  artifactId: string;
  versionId: string;
  contentHash: string;
}
/** A body's look in its CAD version (OH-U1). */
export interface BimPartLook {
  /** `#rrggbb`. */
  color: string;
  opacity: number;
}
/**
 * A version's shape: its active bodies as one BRep, their bounds and kinds. `looks` and `faces`,
 * when given, are each body's appearance and face count in the BRep's order: a mesh's face
 * indices map to bodies through them. A source without them is drawn in the part colour.
 */
export interface BimPartShape {
  brep: Uint8Array;
  bounds: [Vec3, Vec3];
  kinds: ('solid' | 'sheet')[];
  looks?: BimPartLook[];
  faces?: number[];
}
export interface BimPartSource {
  /** The CAD Artifacts and saved versions that can be placed. */
  list(): Promise<BimPartCandidate[]>;
  /** The exact version's shape. Rejects with an Error whose message is a code. */
  shape(source: BimPartReference): Promise<BimPartShape>;
  /** Keeps the version with the building (its retained closure) before an edit names it. */
  retain(source: BimPartReference): Promise<void>;
}
/** A part type's shape, by its version's content hash. */
export type BimPartStatus =
  | { status: 'loading' }
  /**
   * `kinds` are the version's bodies: a sheet among them is drawn from both sides. `bounds` hold
   * the shape, so a drawing leaves out a part wholly outside what it keeps. `looks` and `faces`
   * colour it body by body (see `BimPartShape`).
   */
  | ({ status: 'available' } & Pick<BimPartShape, 'kinds'> &
      Partial<Pick<BimPartShape, 'bounds' | 'looks' | 'faces'>>)
  | { status: 'unavailable'; code: string };

/**
 * OH-U1: the body of each face of a version's BRep, by face index (a mesh's face indices count
 * the BRep's faces in body order). Undefined without looks for every body.
 */
export function partFaceBodies(
  status: Extract<BimPartStatus, { status: 'available' }>,
): number[] | undefined {
  const { looks, faces, kinds } = status;
  if (!looks || !faces || looks.length !== faces.length || kinds.length !== faces.length)
    return undefined;
  const bodyOf: number[] = [];
  faces.forEach((n, body) => {
    for (let k = 0; k < n; k++) bodyOf.push(body);
  });
  return bodyOf;
}
