/**
 * R2b-1 fixture (docs/cad/r2b-assembly.md, F20–F25 base): saved part versions placed by fixed
 * components, with a nested sub-assembly. Content only; no geometry is asserted here.
 */
import type { CadComponent, CadPartDef } from './assembly';
import { f02Plate, f03Revolve, fixtureKernel } from './fixtures';
import {
  emptyCad,
  identityQuaternion,
  position,
  type CadDocument,
  type CadKernelProfile,
  type Vec3,
} from './model';
import { applyCadOperation, cadContentHash } from './operations';

/** A saved version as a Host's closure keeps it. */
export interface CadFixtureVersion {
  artifactId: string;
  versionId: string;
  contentHash: string;
  content: CadDocument;
}
export const fixtureVersion = (
  artifactId: string,
  versionId: string,
  content: CadDocument,
): CadFixtureVersion => ({ artifactId, versionId, contentHash: cadContentHash(content), content });

export const fixturePart = (
  id: string,
  name: string,
  v: CadFixtureVersion,
  boundsMm: [Vec3, Vec3] = [
    [0, 0, 0],
    [100, 50, 5],
  ],
): CadPartDef => ({
  id,
  name,
  source: {
    kind: 'version',
    artifactId: v.artifactId,
    versionId: v.versionId,
    contentHash: v.contentHash,
  },
  hint: { boundsMm },
});
export const fixtureComponent = (
  id: string,
  partId: string,
  at: Vec3 = [0, 0, 0],
  rotation = identityQuaternion(),
): CadComponent => ({
  id,
  name: id,
  partId,
  placement: { translation: position(...at), rotation },
  bom: 'include',
});

/**
 * Plate and shaft versions, a "pair" sub-assembly with two plates, and an assembly with one
 * shaft, two plates and the pair. `closure` holds every version by content hash. `kernel` pins
 * every version to one build (a kernel test passes the real one).
 */
export function r2bParts(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const on = (doc: CadDocument): CadDocument => ({
    ...doc,
    kernelProfile: { ...doc.kernelProfile, ...kernel },
  });
  const plate = fixtureVersion('plate', 'v1', on(f02Plate()));
  const shaft = fixtureVersion('shaft', 'v1', on(f03Revolve()));
  let pair = emptyCad(kernel);
  pair = applyCadOperation(pair, {
    type: 'insertComponents',
    parts: [fixturePart('p-plate', 'Plate', plate)],
    components: [
      fixtureComponent('pair-a', 'p-plate'),
      fixtureComponent('pair-b', 'p-plate', [0, 0, 20]),
    ],
  });
  const pairV = fixtureVersion('pair', 'v1', pair);
  let assembly = emptyCad(kernel);
  assembly = applyCadOperation(assembly, {
    type: 'insertComponents',
    parts: [
      fixturePart('part-plate', 'Plate', plate),
      fixturePart('part-shaft', 'Shaft', shaft, [
        [-20, -20, 0],
        [20, 20, 40],
      ]),
      fixturePart('part-pair', 'Pair', pairV, [
        [0, 0, 0],
        [100, 50, 25],
      ]),
    ],
    components: [
      fixtureComponent('c-plate-1', 'part-plate'),
      fixtureComponent('c-plate-2', 'part-plate', [0, 100, 0]),
      fixtureComponent('c-shaft', 'part-shaft', [50, 25, 5]),
      fixtureComponent('c-pair', 'part-pair', [200, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]),
    ],
  });
  const closure = new Map([plate, shaft, pairV].map((v) => [v.contentHash, v.content] as const));
  return { plate, shaft, pair: pairV, assembly, closure };
}
