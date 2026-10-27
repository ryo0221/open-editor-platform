import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  f01Empty,
  fixtureKernel,
  type CadAssetRef,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadKernelPort,
} from '@editor-platform/cad-core';
import type { CadStepImportResult } from '@editor-platform/cad-kernel-occt';
import { cadInputState } from './binding';
import { CadController, type CadAssetStore } from './controller';

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const body = {
  kind: 'solid' as const,
  volumeMm3: 100,
  areaMm2: 10,
  bounds: [
    [0, 0, 0],
    [25.4, 25.4, 25.4],
  ] as [[number, number, number], [number, number, number]],
};
const read = (): CadStepImportResult => ({
  status: 'ok',
  brep: new Uint8Array([2, 2]),
  report: {
    source: { sha256: sha('a'), byteLength: 3, schema: 'AP214', fileSchema: 'AUTOMOTIVE_DESIGN' },
    importerBuildHash: fixtureKernel.buildHash,
    sourceUnit: 'in',
    scaleToMm: 25.4,
    maxToleranceMm: 1e-7,
    body,
    brep: { sha256: sha('b'), byteLength: 2 },
    healing: 'none',
    losses: ['product-names', 'source-feature-history'],
  },
});

/** A Host store that records staging; `refuse` makes it throw like a full storage. */
function setup({
  refuse,
  stored = true,
  hold,
  canEdit = () => true,
}: { refuse?: string; stored?: boolean; hold?: Promise<void>; canEdit?: () => boolean } = {}) {
  const staged: { ref: CadAssetRef; bytes: Uint8Array }[][] = [];
  const requests: CadEvaluateRequest[] = [];
  const assets: CadAssetStore = {
    get: () => undefined,
    stage: async (list) => {
      await hold;
      if (refuse) throw new Error(refuse);
      staged.push(list);
    },
  };
  const kernel: CadKernelPort = {
    evaluate: async (request): Promise<CadEvaluation> => {
      requests.push(request);
      const doc = request.document;
      return {
        status: 'ok',
        contentHash: request.candidateHash,
        buildHash: fixtureKernel.buildHash,
        geometryDigest: 'd',
        bodies: Object.fromEntries(doc.bodies.map((b) => [b.id, body])),
      };
    },
    cancel: () => {},
  };
  let ids = 0;
  const session = new EditorSession(f01Empty());
  const controller = new CadController({
    session,
    kernel,
    canEdit,
    permissionGeneration: () => 1,
    newId: (prefix) => `${prefix}-${++ids}`,
    importStep: async () => read(),
    ...(stored ? { assets } : {}),
  });
  return { controller, session, staged, requests };
}

describe('CadController STEP import (CAD11/CAD13)', () => {
  it('reads the file into a report, stores both assets, then inserts one imported body', async () => {
    const { controller, session, staged } = setup();
    await controller.refresh();
    expect(controller.getSnapshot().canImportStep).toBe(true);
    const preview = await controller.prepareStepImport('bracket.STEP', new Uint8Array([1, 2, 3]));
    expect(preview?.report.sourceUnit).toBe('in');
    // Reading changes nothing and stores nothing.
    expect(session.content.features).toEqual([]);
    expect(staged).toEqual([]);
    expect(await controller.adoptStepImport()).toBe(true);
    expect(staged[0].map((a) => [a.ref.kind, a.ref.sha256, [...a.bytes]])).toEqual([
      ['source-step', sha('a'), [1, 2, 3]],
      ['normalized-brep', sha('b'), [2, 2]],
    ]);
    const doc = session.content;
    expect(doc.assets.map((a) => a.id)).toEqual(staged[0].map((a) => a.ref.id));
    expect(doc.features[0]).toMatchObject({
      type: 'imported',
      name: 'bracket.STEP',
      args: { sourceUnit: 'in', scaleToMm: 25.4, importer: { buildHash: fixtureKernel.buildHash } },
    });
    expect(doc.bodies).toMatchObject([{ name: 'bracket', state: 'active' }]);
    // One edit: Undo removes the body and its refs together.
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.content.assets).toEqual([]);
  });

  it('reuses refs of a file already imported', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    await controller.prepareStepImport('a.step', new Uint8Array([1, 2, 3]));
    await controller.adoptStepImport();
    await controller.prepareStepImport('b.step', new Uint8Array([1, 2, 3]));
    await controller.adoptStepImport();
    expect(session.content.assets).toHaveLength(2);
    expect(session.content.bodies).toHaveLength(2);
  });

  it('is busy while the Host stores the file, so no save captures the record in between', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { controller, session } = setup({ hold });
    await controller.refresh();
    await controller.prepareStepImport('a.step', new Uint8Array([1, 2, 3]));
    const adopting = controller.adoptStepImport();
    expect(controller.getSnapshot().busy).toBe(true);
    // Not settling work: even a save that keeps the editor open waits for the stored bytes.
    expect(cadInputState(controller)).toEqual({ dirty: true, settles: false });
    release();
    expect(await adopting).toBe(true);
    expect(controller.getSnapshot().busy).toBe(false);
    expect(session.content.bodies).toHaveLength(1);
    // A failed store ends the pending state too.
    let fail!: () => void;
    const failing = setup({ refuse: 'full', hold: new Promise<void>((r) => (fail = r)) });
    await failing.controller.refresh();
    await failing.controller.prepareStepImport('a.step', new Uint8Array([1, 2, 3]));
    const refused = failing.controller.adoptStepImport();
    expect(failing.controller.getSnapshot().busy).toBe(true);
    fail();
    expect(await refused).toBe(false);
    expect(failing.controller.getSnapshot().busy).toBe(false);
  });

  it('a Host that turns read-only while the file is stored does not leave the editor busy', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let editable = true;
    const { controller, session } = setup({ hold, canEdit: () => editable });
    await controller.refresh();
    await controller.prepareStepImport('a.step', new Uint8Array([1, 2, 3]));
    const adopting = controller.adoptStepImport();
    editable = false;
    release();
    expect(await adopting).toBe(false);
    expect(controller.getSnapshot().busy).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('permission-denied');
    expect(session.content.features).toEqual([]);
  });

  it('leaves the content unchanged when the Host cannot store the file', async () => {
    const { controller, session } = setup({ refuse: '（保存容量が足りません）' });
    await controller.refresh();
    await controller.prepareStepImport('a.step', new Uint8Array([1, 2, 3]));
    expect(await controller.adoptStepImport()).toBe(false);
    expect(session.content.features).toEqual([]);
    expect(controller.getSnapshot().diagnostic?.message).toContain('保存容量が足りません');
  });

  it('is not offered by a Host without asset storage', async () => {
    const { controller } = setup({ stored: false });
    await controller.refresh();
    expect(controller.getSnapshot().canImportStep).toBe(false);
    expect(controller.importAvailable).toBe(false);
    expect(await controller.prepareStepImport('a.step', new Uint8Array(1))).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('step-import-unavailable');
  });

  it('shows the refusal with what it found, and discards a read file on cancel', async () => {
    const { controller, session } = setup();
    const c = controller as unknown as {
      options: { importStep: () => Promise<CadStepImportResult> };
    };
    c.options.importStep = async () => ({
      status: 'rejected',
      code: 'step-schema-unsupported',
      detail: 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF',
    });
    await controller.refresh();
    await controller.prepareStepImport('a.step', new Uint8Array(1));
    expect(controller.getSnapshot().diagnostic?.message).toMatch(/AP203またはAP214.*AP242/);
    c.options.importStep = async () => read();
    await controller.prepareStepImport('a.step', new Uint8Array(1));
    controller.cancelStepImport();
    expect(controller.getSnapshot().stepImport).toBeUndefined();
    expect(await controller.adoptStepImport()).toBe(false);
    expect(session.content.features).toEqual([]);
  });
});
