/**
 * R2b-2b fixture F21 (docs/cad/r2b-assembly.md, Fixtureと受け入れscenario): base plate versions
 * v1–v4 of one Artifact and an assembly whose shaft turns on the base's top face. v2 is wider
 * (the face resolves and the shaft moves with it), v3 cuts a groove across the top as a second
 * tool of the same cut (the face splits: ambiguous), v4 has no cut at all (missing). A "tower"
 * sub-assembly places two bases; its v2 drops the upper one (the child's relative path is
 * missing) and its v3 puts base v3 there (the face through that path is ambiguous). The frames
 * below are analytic; a kernel must classify the same way.
 */
import { identityPose, type CadSolvedPose } from './assembly';
import {
  fixtureComponent,
  fixturePart,
  fixtureVersion,
  r2bParts,
  type CadFixtureVersion,
} from './assembly-fixtures';
import { f02Plate, fixtureKernel } from './fixtures';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint, f20TopFace } from './joints-fixtures';
import { connectorRefKey, solveJoints, type CadConnectorFrame } from './joints';
import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
  type CadKernelProfile,
} from './model';
import { applyCadOperation, cadContentHash } from './operations';
import type { CadTopologyRef } from './topology';
import { assertCad } from './validation';

/**
 * The two halves of the top face that v3's groove leaves (x < 37 and x > 43), as candidates,
 * with the rectangles' centroids (the hole moves the real ones a little).
 */
export const f21Halves: CadTopologyRef[] = [
  {
    ...f20TopFace,
    select: { adjacent: [[['start']]] },
    hint: { ...f20TopFace.hint, centroid: [18.5, 25, 5] },
  },
  {
    ...f20TopFace,
    select: { adjacent: [[['end']]] },
    hint: { ...f20TopFace.hint, centroid: [61.5, 25, 5] },
  },
];

/** The base plate's versions (F02 with the assembly's build). */
export function f21Bases(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const on = (doc: CadDocument): CadDocument => ({
    ...doc,
    kernelProfile: { ...doc.kernelProfile, ...kernel },
  });
  const v1 = on(f02Plate());
  const v2 = applyCadOperation(v1, { type: 'setParameter', parameterId: 'W', value: 100 });
  const grey = { color: '#9aa4b1', opacity: 1 };
  const body = (id: string, sourceFeatureId: string) => ({
    id,
    name: id,
    sourceFeatureId,
    placementFeatureId: `${id}-placement`,
    appearance: grey,
  });
  const source = (ids: string[]) => v1.features.filter((f) => ids.includes(f.id));
  // A groove 6 mm wide and 2 mm deep across the whole top, cut by the same Boolean as the hole.
  let v3 = applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: v1.parameters,
    profiles: v1.profiles,
    features: [
      ...source(['plate-extrude', 'hole-cylinder']),
      {
        id: 'groove-box',
        name: 'Groove tool',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [mm(6), mm(60), mm(5)],
          origin: position(37, -5, 3),
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [
      body('plate', 'plate-extrude'),
      body('hole', 'hole-cylinder'),
      body('groove', 'groove-box'),
    ],
  });
  v3 = applyCadOperation(v3, {
    type: 'booleanBodies',
    targetId: 'plate',
    toolIds: ['hole', 'groove'],
    mode: 'cut',
    booleanFeatureId: 'plate-cut',
    placementFeatureId: 'plate-cut-placement',
  });
  // The plate alone: no cut, so its result is another feature.
  const v4 = applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: v1.parameters,
    profiles: v1.profiles,
    features: source(['plate-extrude']),
    bodies: [body('plate', 'plate-extrude')],
  });
  return [v1, v2, v3, v4].map((d, i) => fixtureVersion('base', `v${i + 1}`, d));
}

const tower = (
  base: CadFixtureVersion,
  top: CadFixtureVersion | undefined,
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>,
) => {
  const parts = [fixturePart('t-base-part', 'Base', base)];
  if (top && top.contentHash !== base.contentHash)
    parts.push(fixturePart('t-top-part', 'Base', top));
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertComponents',
    parts,
    components: [
      fixtureComponent('t-base', 't-base-part'),
      ...(top
        ? [fixtureComponent('t-top', parts.length > 1 ? 't-top-part' : 't-base-part', [0, 0, 20])]
        : []),
    ],
  });
};

export function r2bVersions(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const bases = f21Bases(kernel);
  const [v1, , v3] = bases as [CadFixtureVersion, CadFixtureVersion, CadFixtureVersion];
  const { shaft } = r2bParts(kernel);
  const towers = [tower(v1, v1, kernel), tower(v1, undefined, kernel), tower(v1, v3, kernel)].map(
    (d, i) => fixtureVersion('tower', `v${i + 1}`, d),
  );
  const [t1] = towers as [CadFixtureVersion];
  const closure = new Map(
    [...bases, ...towers, shaft].map((v) => [v.contentHash, v.content] as const),
  );
  const doc = emptyCad(kernel);
  doc.parts = [
    fixturePart('part-base', 'Base', v1),
    fixturePart('part-shaft', 'Shaft', shaft, [
      [-15, -15, 0],
      [15, 15, 20],
    ]),
    fixturePart('part-tower', 'Tower', t1, [
      [0, 0, 0],
      [80, 50, 25],
    ]),
  ];
  doc.components = [
    fixtureComponent('c-base', 'part-base'),
    { ...fixtureComponent('c-shaft', 'part-shaft'), placement: null },
    fixtureComponent('c-tower', 'part-tower', [0, 100, 0]),
    { ...fixtureComponent('c-cap', 'part-shaft'), placement: null },
  ];
  doc.joints = [
    // The shaft stands on the base's top face; the cap stands on the tower's upper base.
    fixtureJoint(
      'j-axle',
      'revolute',
      { ...fixtureConnector(['c-base']), ref: f20TopFace },
      'c-shaft',
      fixtureConnector(),
      {
        angle: { literalRad: 0 },
      },
    ),
    fixtureJoint(
      'j-cap',
      'fastened',
      { ...fixtureConnector(['c-tower', 't-top']), ref: f20TopFace },
      'c-cap',
      fixtureConnector(),
    ),
  ];
  const frames = f21Frames(bases);
  doc.solvedPoses = Object.fromEntries(doc.components.map((c) => [c.id, identityPose()]));
  const solved = solveJoints(
    doc,
    parameterValues(doc),
    (h) => closure.get(h),
    (at, ref) => frames.get(`${at} ${connectorRefKey(ref)}`),
    () => true,
  );
  doc.solvedPoses = solved.poses;
  assertCad(doc);
  return { bases, towers, shaft, closure, assembly: doc, frames, hash: cadContentHash(doc) };
}

/** Analytic connector frames by `${content hash} ${connectorRefKey}`. */
export function f21Frames(bases: CadFixtureVersion[]) {
  const [v1, v2, v3, v4] = bases as [
    CadFixtureVersion,
    CadFixtureVersion,
    CadFixtureVersion,
    CadFixtureVersion,
  ];
  const at = (t: [number, number, number]): CadSolvedPose => ({
    translationMm: t,
    rotation: [0, 0, 0, 1],
  });
  const top = connectorRefKey(f20TopFace);
  const frames = new Map<string, CadConnectorFrame>([
    [`${v1.contentHash} ${top}`, { status: 'resolved', frame: at([40, 25, 5]) }],
    [`${v2.contentHash} ${top}`, { status: 'resolved', frame: at([50, 25, 5]) }],
    [
      `${v3.contentHash} ${top}`,
      {
        status: 'ambiguous',
        candidates: f21Halves.map((ref) => ({ ref, hint: ref.hint })),
      },
    ],
    [`${v4.contentHash} ${top}`, { status: 'missing', candidates: [] }],
  ]);
  frames.set(`${v3.contentHash} ${connectorRefKey(f21Halves[0]!)}`, {
    status: 'resolved',
    frame: at([18.5, 25, 5]),
  });
  frames.set(`${v3.contentHash} ${connectorRefKey(f21Halves[1]!)}`, {
    status: 'resolved',
    frame: at([61.5, 25, 5]),
  });
  return frames;
}
