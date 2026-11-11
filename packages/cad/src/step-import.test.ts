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
    get: (sha) => staged.flat().find((a) => a.ref.sha256 === sha)?.bytes,
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

  it('stores the PMI the import kept beside the BRep and names it on the feature (PMI-2)', async () => {
    const { controller, session, staged } = setup();
    const c = controller as unknown as {
      options: { importStep: () => Promise<CadStepImportResult> };
    };
    c.options.importStep = async () => {
      const r = read();
      if (r.status !== 'ok') throw new Error('read');
      return {
        ...r,
        pmi: new Uint8Array([7, 7, 7]),
        report: { ...r.report, pmiAsset: { sha256: sha('e'), byteLength: 3 } },
      };
    };
    await controller.refresh();
    await controller.prepareStepImport('plate.step', new Uint8Array([1, 2, 3]));
    expect(await controller.adoptStepImport()).toBe(true);
    expect(staged[0].map((a) => [a.ref.kind, a.ref.mediaType, [...a.bytes]])).toEqual([
      ['source-step', 'model/step', [1, 2, 3]],
      ['normalized-brep', 'model/x-occt-brep', [2, 2]],
      ['pmi', 'application/json', [7, 7, 7]],
    ]);
    const doc = session.content;
    const pmi = doc.assets.find((a) => a.kind === 'pmi');
    expect(doc.features[0]).toMatchObject({ args: { pmiAssetId: pmi?.id } });
  });

  it('lists the kept PMI of the selected body and highlights one item until the selection changes (PMI-2)', async () => {
    const { controller, session } = setup();
    const asset = {
      version: 1,
      items: [{ id: 'pmi-1', kind: 'datum', name: 'A', targets: [{ shape: 'face', index: 1 }] }],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(asset));
    const c = controller as unknown as {
      options: { importStep: () => Promise<CadStepImportResult> };
    };
    c.options.importStep = async () => {
      const r = read();
      if (r.status !== 'ok') throw new Error('read');
      return {
        ...r,
        pmi: bytes,
        report: { ...r.report, pmiAsset: { sha256: sha('e'), byteLength: bytes.byteLength } },
      };
    };
    await controller.refresh();
    await controller.prepareStepImport('plate.step', new Uint8Array([1, 2, 3]));
    await controller.adoptStepImport();
    const body = session.content.bodies[0]!;
    expect(controller.bodyPmi(body.id)).toMatchObject({ state: { status: 'current' }, asset });
    // Only on the selected body.
    controller.focusPmi('pmi-1');
    expect(controller.getSnapshot().pmiFocus).toBeUndefined();
    controller.select({ kind: 'body', id: body.id });
    controller.focusPmi('pmi-1');
    expect(controller.getSnapshot().pmiFocus).toEqual({ bodyId: body.id, itemId: 'pmi-1' });
    controller.select({ kind: 'body', id: body.id });
    expect(controller.getSnapshot().pmiFocus).toEqual({ bodyId: body.id, itemId: 'pmi-1' });
    controller.select(null);
    expect(controller.getSnapshot().pmiFocus).toBeUndefined();
    // PMI-3b: a saved view of the selected body, until the selection changes or All PMI.
    controller.showPmiView('view-1');
    expect(controller.getSnapshot().pmiView).toBeUndefined();
    controller.select({ kind: 'body', id: body.id });
    controller.showPmiView('view-1');
    const first = controller.getSnapshot().pmiView!;
    expect(first).toMatchObject({ bodyId: body.id, viewId: 'view-1' });
    // Choosing the same view again is a new choice: the viewport aims again.
    controller.showPmiView('view-1');
    expect(controller.getSnapshot().pmiView!.chosen).toBeGreaterThan(first.chosen);
    controller.showPmiView(undefined);
    expect(controller.getSnapshot().pmiView).toBeUndefined();
    controller.showPmiView('view-1');
    controller.select(null);
    expect(controller.getSnapshot().pmiView).toBeUndefined();
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
      detail: 'STRUCTURAL_ANALYSIS_DESIGN',
    });
    await controller.refresh();
    await controller.prepareStepImport('a.step', new Uint8Array(1));
    expect(controller.getSnapshot().diagnostic?.message).toMatch(
      /AP203・AP214・AP242.*STRUCTURAL_ANALYSIS_DESIGN/,
    );
    c.options.importStep = async () => read();
    await controller.prepareStepImport('a.step', new Uint8Array(1));
    controller.cancelStepImport();
    expect(controller.getSnapshot().stepImport).toBeUndefined();
    expect(await controller.adoptStepImport()).toBe(false);
    expect(session.content.features).toEqual([]);
  });

  it('asks before importing a file whose PMI is not kept, and reads it again only with consent (PMI-1)', async () => {
    const { controller, session } = setup();
    const calls: unknown[] = [];
    const pmi = {
      census: { dimension: 2 },
      read: { dimensions: 2, tolerances: 0, datums: 0, views: 0 },
      axes: [],
      kept: {
        dimension: 0,
        'geometric-tolerance': 0,
        datum: 0,
        'datum-target': 0,
        callout: 0,
        view: 0,
      },
      complete: true,
      lossless: false,
    };
    const c = controller as unknown as {
      options: {
        importStep: (
          p: unknown,
          id: string,
          b: Uint8Array,
          o?: unknown,
        ) => Promise<CadStepImportResult>;
      };
    };
    c.options.importStep = async (_p, _id, _b, options) => {
      calls.push(options);
      return (options as { pmi?: string } | undefined)?.pmi === 'discard'
        ? read()
        : { status: 'rejected', code: 'step-pmi-partial', detail: 'not-kept', pmi };
    };
    await controller.refresh();
    const asked: unknown[] = [];
    expect(
      await controller.prepareStepImport('p.step', new Uint8Array(1), {
        onPmi: (r) => asked.push(r),
      }),
    ).toBeUndefined();
    expect(asked).toEqual([pmi]);
    // Asking is not a failure, and nothing is read or stored yet.
    expect(controller.getSnapshot().diagnostic).toBeUndefined();
    expect(controller.getSnapshot().stepImport).toBeUndefined();
    // Without someone to ask, the refusal is shown.
    await controller.prepareStepImport('p.step', new Uint8Array(1));
    expect(controller.getSnapshot().diagnostic?.message).toMatch(/PMI/);
    const preview = await controller.prepareStepImport('p.step', new Uint8Array(1), {
      pmi: 'discard',
    });
    expect(preview).toBeDefined();
    expect(calls).toEqual([{}, {}, { pmi: 'discard' }]);
    expect(session.content.features).toEqual([]);
  });
});
