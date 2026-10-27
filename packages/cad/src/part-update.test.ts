import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  CadAssemblyPort,
  cadContentHash,
  connectorRefKey,
  partVersionId,
  r2bVersions,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadFixtureVersion,
  type CadPartKernelPort,
} from '@editor-platform/cad-core';
import { CadAssembly, type CadPartSourceHost } from './assembly';
import { CadController } from './controller';

/** F21 in a controller over a kernel double with its analytic frames, and a Host offering every version. */
function setup(options: { tamper?: boolean; denied?: string } = {}) {
  const f = r2bVersions();
  const answer = (request: CadEvaluateRequest, at: string): CadEvaluation => ({
    status: 'ok',
    contentHash: request.candidateHash,
    buildHash: request.document.kernelProfile.buildHash,
    geometryDigest: 'd',
    // A plate for every document with bodies; a sub-assembly has none of its own.
    bodies: request.document.bodies.some((b) => b.state === 'active')
      ? {
          plate: {
            kind: 'solid',
            volumeMm3: 1000,
            areaMm2: 1,
            bounds: [
              [0, 0, 0],
              [80, 50, 5],
            ],
          },
        }
      : {},
    ...(request.connectors
      ? {
          connectors: request.connectors.map(
            (r) =>
              f.frames.get(`${at} ${connectorRefKey(r)}`) ?? { status: 'missing', candidates: [] },
          ),
        }
      : {}),
  });
  const kernel: CadPartKernelPort = {
    evaluate: async (r) => answer(r, 'own'),
    evaluatePart: async (r) => (assembly.receive(r.candidateHash, []), answer(r, r.candidateHash)),
    cancel: () => {},
  };
  const staged: string[] = [];
  const store = {
    get: (h: string) => f.closure.get(h),
    stage: async (versions: { parameters: unknown }[]) =>
      void staged.push(...versions.map((v) => cadContentHash(v as never))),
  };
  const offered: Record<string, CadFixtureVersion[]> = { base: f.bases, tower: f.towers };
  const source: CadPartSourceHost = {
    list: async () =>
      Object.entries(offered).map(([artifactId, versions]) => ({
        artifactId,
        name: artifactId,
        versions: versions.map((v) => ({
          versionId: v.versionId,
          label: v.versionId,
          contentHash: v.contentHash,
        })),
      })),
    readVersion: async (artifactId, versionId) => {
      const v = offered[artifactId]!.find((x) => x.versionId === versionId)!;
      const content = options.tamper
        ? { ...v.content, parameters: [...v.content.parameters].reverse() }
        : v.content;
      return { content, contentHash: v.contentHash, closure: [], assets: [] };
    },
    latestVersion: (artifactId) => {
      const v = offered[artifactId]?.at(-1);
      return v && { versionId: v.versionId, contentHash: v.contentHash, label: v.versionId };
    },
    checkAccess: (artifactId) => artifactId !== options.denied,
  };
  const port = new CadAssemblyPort({ kernel, parts: store.get });
  const session = new EditorSession(f.assembly);
  const controller = new CadController({
    session,
    kernel: port,
    canEdit: () => true,
    permissionGeneration: () => 0,
  });
  const assembly: CadAssembly = new CadAssembly({ controller, port, store, source });
  return { f, session, controller, assembly, staged, port };
}
const at = (c: CadController, id: string) =>
  c.getSnapshot().content.solvedPoses[id]!.translationMm.map((x) => +x.toFixed(9));

describe('part version updates in the Surface (R2b-2b, CAD48)', () => {
  it('shows a newer version without taking it, previews what changes, and adopts it as one edit', async () => {
    const { f, controller, assembly, staged } = setup();
    await controller.refresh();
    // The Host's newest versions are shown, never taken in by themselves.
    expect(assembly.newerVersion('part-base')).toMatchObject({ versionId: 'v4' });
    expect(assembly.newerVersion('part-shaft')).toBeUndefined();
    expect(cadContentHash(controller.getSnapshot().content)).toBe(f.hash);
    expect(await assembly.prepareUpdate([{ partId: 'part-base', versionId: 'v2' }])).toBe(true);
    const update = assembly.getSnapshot().update!;
    expect(update).toMatchObject({
      status: 'ready',
      parts: [{ partId: 'part-base', from: 'v1', to: 'v2' }],
      moved: ['c-shaft'],
    });
    expect(update.parts[0]!.toSummary).toEqual({ sizeMm: [80, 50, 5], volumeMm3: 1000 });
    // The version was kept in the closure before the edit names it; nothing is stored yet.
    expect(staged).toContain(f.bases[1]!.contentHash);
    expect(cadContentHash(controller.getSnapshot().content)).toBe(f.hash);
    expect(assembly.applyUpdate()).toBe(true);
    expect(at(controller, 'c-shaft')).toEqual([50, 25, 5]);
    expect(assembly.getSnapshot().update).toBeUndefined();
    await controller.undo();
    expect(cadContentHash(controller.getSnapshot().content)).toBe(f.hash);
  });

  it('lists the joints an update breaks, and chooses their connectors again with it as one edit', async () => {
    const { f, controller, assembly } = setup();
    await controller.refresh();
    await assembly.prepareUpdate([
      { partId: 'part-base', versionId: 'v3' },
      { partId: 'part-tower', versionId: 'v3' },
    ]);
    expect(assembly.getSnapshot().update).toMatchObject({
      status: 'broken',
      broken: [
        { jointId: 'j-axle', name: 'j-axle' },
        { jointId: 'j-cap', name: 'j-cap' },
      ],
      code: 'connector-ambiguous',
      canChoose: true,
    });
    expect(assembly.chooseUpdate()).toBe(true);
    const rebind = () => controller.getSnapshot().rebind!;
    const settle = () => new Promise((r) => setTimeout(r, 0));
    // The axle's first candidate (nearest the reference's hint) resolves it, so the cap's joint
    // is chosen next, keeping that choice to go back to.
    await settle();
    expect(rebind()).toMatchObject({ featureName: 'j-cap', withEdit: true, canGoBack: true });
    // Back to the axle (its preview of the same choice is superseded by the new one).
    controller.backRebind();
    expect(rebind().featureName).toBe('j-axle');
    controller.chooseRebind(0, 1);
    await settle();
    expect(rebind()).toMatchObject({ featureName: 'j-cap', status: 'ready' });
    // The assembly shows the previewed choice: the new versions, and the shaft on its half.
    const preview = controller.getSnapshot().rebindPreview!;
    expect(preview.content.parts.map((p) => partVersionId(p.source))).toEqual(['v3', 'v1', 'v3']);
    expect(preview.content.solvedPoses['c-shaft']!.translationMm[0]).toBeCloseTo(61.5, 9);
    expect(partVersionId(controller.getSnapshot().content.parts[0]!.source)).toBe('v1');
    expect(controller.confirmRebind()).toBe(true);
    expect(at(controller, 'c-shaft')).toEqual([61.5, 25, 5]);
    expect(at(controller, 'c-cap')).toEqual([18.5, 125, 25]);
    const doc = controller.getSnapshot().content;
    expect(doc.parts.map((p) => partVersionId(p.source))).toEqual(['v3', 'v1', 'v3']);
    await controller.undo();
    expect(cadContentHash(controller.getSnapshot().content)).toBe(f.hash);
  });

  it('says a missing connector has nothing to choose, and drops the preview with another edit', async () => {
    const { controller, assembly } = setup();
    await controller.refresh();
    await assembly.prepareUpdate([{ partId: 'part-base', versionId: 'v4' }]);
    expect(assembly.getSnapshot().update).toMatchObject({
      status: 'broken',
      code: 'connector-missing',
      canChoose: true,
    });
    // Its only candidate list is empty: the choice is blocked, not adopted.
    assembly.chooseUpdate();
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.getSnapshot().rebind?.status).toBe('blocked');
    controller.cancelRebind();
    await assembly.prepareUpdate([{ partId: 'part-tower', versionId: 'v2' }]);
    expect(assembly.getSnapshot().update).toMatchObject({ status: 'broken', canChoose: false });
    // Another edit drops the prepared update.
    await controller.run({ type: 'deleteClosure', ids: ['j-cap'], cascade: false });
    expect(assembly.getSnapshot().update).toBeUndefined();
  });

  it('sums a sub-assembly version over its nested parts, before and after', async () => {
    const { controller, assembly } = setup();
    await controller.refresh();
    await assembly.prepareUpdate([{ partId: 'part-tower', versionId: 'v2' }]);
    // Tower v1 stacks two plates (z 0 to 25); v2 keeps the lower one only.
    expect(assembly.getSnapshot().update?.parts[0]).toMatchObject({
      fromSummary: { sizeMm: [80, 50, 25], volumeMm3: 2000 },
      toSummary: { sizeMm: [80, 50, 5], volumeMm3: 1000 },
    });
  });

  it('never evaluates nested parts that cannot be read, and leaves their volume out', async () => {
    const { f, controller, assembly, port } = setup({ denied: 'base' });
    await controller.refresh();
    const evaluated: string[] = [];
    const evaluate = port.evaluateVersion.bind(port);
    port.evaluateVersion = (d, profile, o) => {
      if (o.requestId.startsWith('cad-update-')) evaluated.push(o.hash!);
      return evaluate(d, profile, o);
    };
    await assembly.prepareUpdate([{ partId: 'part-tower', versionId: 'v2' }]);
    const [from, to] = [f.towers[0]!, f.towers[1]!];
    // Only the tower versions themselves are evaluated; the plates inside count by their bounds.
    expect(new Set(evaluated)).toEqual(new Set([from.contentHash, to.contentHash]));
    // The plates' stored bounds (100 mm wide) stand in for their evaluated 80 mm.
    expect(assembly.getSnapshot().update?.parts[0]).toMatchObject({
      fromSummary: { sizeMm: [100, 50, 25] },
      toSummary: { sizeMm: [100, 50, 5] },
    });
    expect(assembly.getSnapshot().update?.parts[0]!.fromSummary).not.toHaveProperty('volumeMm3');
    expect(assembly.getSnapshot().update?.parts[0]!.toSummary).not.toHaveProperty('volumeMm3');
  });

  it('drops an update cancelled while it is being prepared', async () => {
    const { f, controller, assembly } = setup();
    await controller.refresh();
    const preparing = assembly.prepareUpdate([{ partId: 'part-base', versionId: 'v2' }]);
    assembly.cancelUpdate();
    expect(await preparing).toBe(false);
    expect(assembly.getSnapshot().update).toBeUndefined();
    expect(controller.editPrepared).toBe(false);
    expect(cadContentHash(controller.getSnapshot().content)).toBe(f.hash);
    // A new one is not held up by it.
    expect(await assembly.prepareUpdate([{ partId: 'part-base', versionId: 'v2' }])).toBe(true);
    expect(assembly.getSnapshot().update?.status).toBe('ready');
  });

  it('refuses a version whose content is not the one its hash names', async () => {
    const { f, controller, assembly } = setup({ tamper: true });
    await controller.refresh();
    expect(await assembly.prepareUpdate([{ partId: 'part-base', versionId: 'v2' }])).toBe(false);
    expect(assembly.getSnapshot().update).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.message).toMatch(/一致しない/);
    expect(cadContentHash(controller.getSnapshot().content)).toBe(f.hash);
  });
});
