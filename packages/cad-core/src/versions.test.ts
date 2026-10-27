import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import { partVersionId, posesDiffer, type CadSolvedPose } from './assembly';
import { CadAssemblyPort, type CadPartKernelPort } from './assembly-port';
import { CadCoordinator, type CadEvaluateRequest, type CadEvaluation } from './coordinator';
import { connectorRefKey, type CadConnectorFrame } from './joints';
import { applyCadOperation, cadContentHash, type CadOperation } from './operations';
import { f21Halves, r2bVersions } from './versions-fixtures';
import type { CadFixtureVersion } from './assembly-fixtures';

const at = (t: [number, number, number]): CadSolvedPose => ({
  translationMm: t,
  rotation: [0, 0, 0, 1],
});
const near = (a: CadSolvedPose | undefined, b: CadSolvedPose) =>
  expect(a && posesDiffer(a, b)).toBe(false);

/** Answers with F21's analytic frames, by the evaluated document's content hash. */
function frameKernel(frames: Map<string, CadConnectorFrame>) {
  const answer = (request: CadEvaluateRequest, key: string): CadEvaluation => ({
    status: 'ok',
    contentHash: request.candidateHash,
    buildHash: request.document.kernelProfile.buildHash,
    geometryDigest: 'd',
    bodies: {},
    ...(request.connectors
      ? {
          connectors: request.connectors.map(
            (r) =>
              frames.get(`${key} ${connectorRefKey(r)}`) ?? { status: 'missing', candidates: [] },
          ),
        }
      : {}),
  });
  const kernel: CadPartKernelPort = {
    evaluate: async (request) => answer(request, 'own'),
    evaluatePart: async (request) => answer(request, request.candidateHash),
    cancel: () => undefined,
  };
  return kernel;
}

function setup() {
  const f = r2bVersions();
  const port = new CadAssemblyPort({
    kernel: frameKernel(f.frames),
    parts: (h) => f.closure.get(h),
  });
  const session = new EditorSession(f.assembly);
  const coordinator = new CadCoordinator({
    session,
    kernel: port,
    canEdit: () => true,
    permissionGeneration: () => 1,
  });
  const edit = async (op: CadOperation) => {
    const r = await coordinator.prepare(op);
    if (r.status !== 'ready') return r;
    return coordinator.apply(r.ticket);
  };
  const replace = (...parts: [string, CadFixtureVersion][]): CadOperation => ({
    type: 'replacePartSources',
    parts: parts.map(([partId, v]) => ({
      partId,
      source: {
        kind: 'version',
        artifactId: v.artifactId,
        versionId: v.versionId,
        contentHash: v.contentHash,
      },
      hint: {
        boundsMm: [
          [0, 0, 0],
          [100, 50, 5],
        ],
      },
    })),
  });
  return { ...f, session, coordinator, edit, replace };
}

describe('part version updates (R2b-2b, CAD48)', () => {
  it('takes a version whose connector resolves in one edit, moving its joint children, and Undo returns it', async () => {
    const s = setup();
    near(s.assembly.solvedPoses['c-shaft'], at([40, 25, 5]));
    near(s.assembly.solvedPoses['c-cap'], at([40, 125, 25]));
    expect(await s.edit(s.replace(['part-base', s.bases[1]!]))).toMatchObject({
      status: 'applied',
    });
    const doc = s.coordinator.content;
    expect(partVersionId(doc.parts.find((p) => p.id === 'part-base')!.source)).toBe('v2');
    near(doc.solvedPoses['c-shaft'], at([50, 25, 5]));
    // The tower still places base v1: its cap does not move.
    near(doc.solvedPoses['c-cap'], at([40, 125, 25]));
    await s.coordinator.undo();
    expect(cadContentHash(s.coordinator.content)).toBe(s.hash);
  });

  it('reports an ambiguous connector with its candidates, and takes the version only with a choice in the same edit', async () => {
    const s = setup();
    const update = s.replace(['part-base', s.bases[2]!]);
    const r = await s.coordinator.prepare(update);
    expect(r).toMatchObject({
      status: 'geometry-error',
      evaluation: {
        status: 'error',
        code: 'connector-ambiguous',
        featureId: 'j-axle',
        brokenJoints: ['j-axle'],
        references: [
          {
            featureId: 'j-axle',
            path: ['parent', 'ref'],
            status: 'ambiguous',
            candidates: f21Halves.map((ref) => ({ ref, hint: ref.hint })),
          },
        ],
      },
    });
    // Nothing was stored, and the current content is not shown as broken.
    expect(cadContentHash(s.coordinator.content)).toBe(s.hash);
    expect(s.coordinator.geometryState).toBe('ready');
    const op: CadOperation = {
      type: 'rebindReferences',
      edit: update as Exclude<CadOperation, { type: 'rebindReferences' | 'withSolvedPoses' }>,
      bindings: [{ featureId: 'j-axle', path: ['parent', 'ref'], ref: f21Halves[1]! }],
    };
    expect(await s.edit(op)).toMatchObject({ status: 'applied' });
    const doc = s.coordinator.content;
    expect(doc.joints.find((j) => j.id === 'j-axle')!.parent.ref).toEqual(f21Halves[1]);
    near(doc.solvedPoses['c-shaft'], at([61.5, 25, 5]));
    // One edit: the version and the choice go back together.
    await s.coordinator.undo();
    expect(cadContentHash(s.coordinator.content)).toBe(s.hash);
  });

  it('reports a missing connector without candidates; deleting its joint first lets the version in', async () => {
    const s = setup();
    const update = s.replace(['part-base', s.bases[3]!]);
    expect(await s.coordinator.prepare(update)).toMatchObject({
      status: 'geometry-error',
      evaluation: {
        code: 'connector-missing',
        brokenJoints: ['j-axle'],
        references: [{ featureId: 'j-axle', status: 'missing', candidates: [] }],
      },
    });
    expect(await s.edit({ type: 'deleteClosure', ids: ['j-axle'], cascade: false })).toMatchObject({
      status: 'applied',
    });
    expect(await s.edit(update)).toMatchObject({ status: 'applied' });
    near(s.coordinator.content.solvedPoses['c-shaft'], at([40, 25, 5]));
  });

  it('resolves a sub-assembly update again through the child path: a component gone is missing, a split face ambiguous', async () => {
    const s = setup();
    expect(await s.coordinator.prepare(s.replace(['part-tower', s.towers[1]!]))).toMatchObject({
      status: 'geometry-error',
      evaluation: { code: 'connector-missing', featureId: 'j-cap', brokenJoints: ['j-cap'] },
    });
    const gone = await s.coordinator.prepare(s.replace(['part-tower', s.towers[1]!]));
    // The path itself is gone: nothing to choose there.
    expect(gone.status === 'geometry-error' && gone.evaluation.references).toBeUndefined();
    const update = s.replace(['part-tower', s.towers[2]!]);
    const split = await s.coordinator.prepare(update);
    expect(split).toMatchObject({
      status: 'geometry-error',
      evaluation: {
        code: 'connector-ambiguous',
        references: [{ featureId: 'j-cap', path: ['parent', 'ref'], status: 'ambiguous' }],
      },
    });
    // The candidates are shown where the tower's top plate lies (y + 100, z + 20); the
    // references they would store keep that plate's own hints.
    const candidates =
      split.status === 'geometry-error' ? split.evaluation.references![0]!.candidates : [];
    expect(candidates.map((c) => c.hint.centroid)).toEqual([
      [18.5, 125, 25],
      [61.5, 125, 25],
    ]);
    expect(candidates.map((c) => c.ref)).toEqual(f21Halves);
    expect(
      await s.edit({
        type: 'rebindReferences',
        edit: update as Exclude<CadOperation, { type: 'rebindReferences' | 'withSolvedPoses' }>,
        bindings: [{ featureId: 'j-cap', path: ['parent', 'ref'], ref: f21Halves[0]! }],
      }),
    ).toMatchObject({ status: 'applied' });
    near(s.coordinator.content.solvedPoses['c-cap'], at([18.5, 125, 25]));
  });

  it('updates several parts in one edit, choosing the broken joints one at a time', async () => {
    const s = setup();
    const update = s.replace(['part-base', s.bases[2]!], ['part-tower', s.towers[2]!]);
    const first = await s.coordinator.prepare(update);
    expect(first).toMatchObject({
      status: 'geometry-error',
      evaluation: { featureId: 'j-axle', brokenJoints: ['j-axle', 'j-cap'] },
    });
    const bind = (
      bindings: { featureId: string; ref: (typeof f21Halves)[number] }[],
    ): CadOperation => ({
      type: 'rebindReferences',
      edit: update as Exclude<CadOperation, { type: 'rebindReferences' | 'withSolvedPoses' }>,
      bindings: bindings.map((b) => ({ ...b, path: ['parent', 'ref'] })),
    });
    expect(
      await s.coordinator.prepare(bind([{ featureId: 'j-axle', ref: f21Halves[1]! }])),
    ).toMatchObject({
      status: 'geometry-error',
      evaluation: { featureId: 'j-cap', brokenJoints: ['j-cap'] },
    });
    expect(
      await s.edit(
        bind([
          { featureId: 'j-axle', ref: f21Halves[1]! },
          { featureId: 'j-cap', ref: f21Halves[1]! },
        ]),
      ),
    ).toMatchObject({ status: 'applied' });
    const doc = s.coordinator.content;
    near(doc.solvedPoses['c-shaft'], at([61.5, 25, 5]));
    near(doc.solvedPoses['c-cap'], at([61.5, 125, 25]));
    await s.coordinator.undo();
    expect(cadContentHash(s.coordinator.content)).toBe(s.hash);
  });

  it('refuses a malformed update or binding, and joins two parts that come to name one version', () => {
    const { assembly, bases, shaft } = r2bVersions();
    const source = (v: CadFixtureVersion) => ({
      kind: 'version' as const,
      artifactId: v.artifactId,
      versionId: v.versionId,
      contentHash: v.contentHash,
    });
    const hint = {
      boundsMm: [
        [0, 0, 0],
        [1, 1, 1],
      ] as [[number, number, number], [number, number, number]],
    };
    const run = (op: CadOperation) => () => applyCadOperation(assembly, op);
    expect(run({ type: 'replacePartSources', parts: [] })).toThrow('replace-parts-empty');
    expect(
      run({
        type: 'replacePartSources',
        parts: [{ partId: 'part-base', source: source(bases[0]!), hint }],
      }),
    ).toThrow('replace-part-same');
    expect(
      run({
        type: 'replacePartSources',
        parts: [{ partId: 'part-base', source: source(shaft), hint }],
      }),
    ).toThrow('replace-part-artifact');
    expect(
      run({
        type: 'rebindReferences',
        bindings: [{ featureId: 'j-axle', path: ['parent', 'componentPath'], ref: f21Halves[0]! }],
      }),
    ).toThrow('rebind-path');
    // An origin connector has no stored reference to choose again.
    expect(
      run({
        type: 'rebindReferences',
        bindings: [
          { featureId: 'j-axle', path: ['child', 'connector', 'ref'], ref: f21Halves[0]! },
        ],
      }),
    ).toThrow('rebind-path');
    // A second part on base v2, then the first one updated to v2: one part remains.
    const two = applyCadOperation(assembly, {
      type: 'insertComponents',
      parts: [
        {
          id: 'part-base-2',
          name: 'Base',
          source: source(bases[1]!),
          hint,
        },
      ],
      components: [
        {
          id: 'c-extra',
          name: 'c-extra',
          partId: 'part-base-2',
          placement: {
            translation: [{ literalMm: 0 }, { literalMm: 300 }, { literalMm: 0 }],
            rotation: [0, 0, 0, 1],
          },
          bom: 'include',
        },
      ],
    });
    const joined = applyCadOperation(two, {
      type: 'replacePartSources',
      parts: [{ partId: 'part-base', source: source(bases[1]!), hint }],
    });
    expect(joined.parts.map((p) => p.id)).toEqual(['part-base', 'part-shaft', 'part-tower']);
    expect(joined.components.find((c) => c.id === 'c-extra')!.partId).toBe('part-base');
  });
});
