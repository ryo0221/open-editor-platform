import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { analysisFixture } from '../../analysis-core/src/fixtures';
import { AnalysisController, type AnalysisPort } from './host';
import { testWorker } from './test-worker';
async function fixture() {
  const doc = await analysisFixture(),
    session = new EditorSession(doc);
  let canRead = true,
    ready = true,
    canExport = true,
    canEdit = true,
    generation = 0;
  const port: AnalysisPort = {
    read: () => session.content,
    revision: () => canonicalJson(session.revision),
    generation: () => generation,
    canRead: () => canRead,
    canEdit: () => canEdit,
    inputsReady: () => ready,
    canExport: () => canExport,
    flush() {},
    execute: (c) => {
      session.execute(c);
    },
  };
  return {
    session,
    port,
    denyRead: () => {
      canRead = false;
      generation++;
    },
    pending: () => {
      ready = false;
    },
    denyExport: () => {
      canExport = false;
      generation++;
    },
    controller: new AnalysisController(port, testWorker),
    revoke: () => {
      canEdit = false;
      generation++;
    },
  };
}
it('AN05/19 preview leaves content unchanged; apply is one Undo and rechecks revision', async () => {
  const { session, controller } = await fixture(),
    before = canonicalJson(session.content);
  const candidate = await controller.prepare();
  expect(canonicalJson(session.content)).toBe(before);
  controller.apply(candidate);
  expect(session.content.runs).toHaveLength(1);
  session.undo();
  expect(canonicalJson(session.content)).toBe(before);
  expect(() => controller.apply(candidate)).toThrow('stale-result');
});
it('AN05/08 rejects permission loss, cancel, edit/undo and closed completion', async () => {
  const { session, controller, revoke } = await fixture();
  const candidate = await controller.prepare();
  controller.edit({ ...session.content, title: 'changed' }, 'title');
  session.undo();
  expect(() => controller.apply(candidate)).toThrow('stale-result');
  const second = await controller.prepare();
  revoke();
  expect(() => controller.apply(second)).toThrow('read-only');
  expect(session.content.runs).toHaveLength(0);
  controller.close();
  await expect(controller.run()).rejects.toThrow('closed');
});
it('AN19 refuses tampering with a reviewed candidate', async () => {
  const { controller, session } = await fixture(),
    candidate = await controller.prepare();
  candidate.document.title = 'unreviewed';
  expect(() => controller.apply(candidate)).toThrow('unverified-candidate');
  expect(session.content.runs).toHaveLength(0);
});

it('AN05 cancellation and late duplicate Worker completions preserve the previous success', async () => {
  const { session, port, controller } = await fixture();
  await controller.run();
  const before = canonicalJson(session.content);
  let worker!: Worker;
  let request!: { id: string };
  let terminated = 0;
  const delayed = new AnalysisController(port, () => {
    worker = {
      onmessage: null,
      onerror: null,
      terminate() {
        terminated++;
      },
      postMessage(value: { id: string }) {
        request = value;
      },
    } as unknown as Worker;
    return worker;
  });
  const completion = delayed.run();
  delayed.cancel();
  await expect(completion).rejects.toThrow('cancelled');
  const event = { data: { id: request.id, result: session.content.runs[0] } } as MessageEvent;
  worker.onmessage?.(event);
  worker.onmessage?.(event);
  expect(terminated).toBeGreaterThan(0);
  expect(canonicalJson(session.content)).toBe(before);
});
it('AN08/19 headless pending buffers, source revocation and export permission reject adoption/output', async () => {
  const a = await fixture(),
    candidate = await a.controller.prepare();
  a.pending();
  expect(() => a.controller.apply(candidate)).toThrow('input-pending');
  const b = await fixture(),
    other = await b.controller.prepare();
  b.denyRead();
  expect(() => b.controller.apply(other)).toThrow('source-access-denied');
  const c = await fixture();
  await c.controller.run();
  const run = c.session.content.runs[0];
  c.denyExport();
  await expect(c.controller.verifiedOutput(run.id, 'total-output')).rejects.toThrow(
    'export-denied',
  );
});
it('AN06/18 preflight checks every retained native version, not just the valid draft', async () => {
  const { createArtifact, commitVersion, contentHash } = await import(
    '@editor-platform/artifact-core'
  );
  const { calculateRun } = await import('@editor-platform/analysis-core');
  const { verifyAnalysisArtifact } = await import('./host');
  const doc = await analysisFixture();
  doc.runs = [await calculateRun(doc, 'saved')];
  const artifact = structuredClone(
    await commitVersion(createArtifact('analysis', 'Analysis', doc), 'local', 'old'),
  );
  artifact.versions[0].content = structuredClone(doc);
  artifact.versions[0].content.runs[0].results['total-output'].rows[0].values.total = '99';
  artifact.versions[0].content.runs[0].resultHash = await contentHash(
    artifact.versions[0].content.runs[0].results,
  );
  artifact.versions[0].contentHash = await contentHash(artifact.versions[0].content);
  await expect(verifyAnalysisArtifact(artifact)).rejects.toThrow('unverified-result');
  expect(artifact.draft.content.runs[0].results['total-output'].rows[0].values.total).toBe('80');
});
it('AN07 Analysis preflight participates in native save failure/retry without losing edits or prior versions', async () => {
  const { ArtifactEditor } = await import('@editor-platform/editor-host');
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const { analysisHostAdapter } = await import('./host');
  const { replaceAnalysis, calculateRun } = await import('@editor-platform/analysis-core');
  const doc = await analysisFixture();
  doc.runs = [await calculateRun(doc, 'original')];
  let fail = true;
  const host = new ArtifactEditor(
    createArtifact('analysis', 'Analysis', doc),
    analysisHostAdapter,
    {
      async put() {
        if (fail) throw Error('quota');
      },
    },
  );
  const guard = { canEdit: () => true, canRead: () => true, inputsReady: () => true };
  host.execute(replaceAnalysis(host.content, { ...host.content, title: 'edited' }, guard));
  await expect(host.save({ commitVersion: true })).rejects.toMatchObject({ code: 'save-failed' });
  expect(host.snapshot.dirty).toBe(true);
  expect(host.content.runs).toEqual(doc.runs);
  expect(host.artifact.versions).toHaveLength(0);
  fail = false;
  await host.save({ commitVersion: true });
  const bytes = canonicalJson(host.artifact.versions[0]);
  host.execute(replaceAnalysis(host.content, { ...host.content, title: 'next edit' }, guard));
  await host.save({ commitVersion: true });
  expect(canonicalJson(host.artifact.versions[0])).toBe(bytes);
  expect(host.artifact.versions).toHaveLength(2);
});
it('inspection rejects pending input and revoked/changed completions without editing', async () => {
  const a = await fixture();
  const before = canonicalJson(a.session.content);
  await expect(a.controller.inspect()).resolves.toMatchObject({ findings: [], error: null });
  expect(canonicalJson(a.session.content)).toBe(before);
  a.pending();
  await expect(a.controller.inspect()).rejects.toThrow('input-pending');
  const b = await fixture();
  const pending = b.controller.inspect();
  b.denyRead();
  await expect(pending).rejects.toThrow('stale-inspection');
  const c = await fixture();
  const pendingEdit = c.controller.inspect();
  c.controller.edit({ ...c.session.content, title: 'changed' }, 'title');
  await expect(pendingEdit).rejects.toThrow('stale-inspection');
});
it('restoring successful inputs uses normal guarded commands and one Undo', async () => {
  const { restoreAnalysisInputs } = await import('@editor-platform/analysis-core');
  const a = await fixture();
  await a.controller.run();
  a.controller.edit({ ...a.session.content, title: 'Keep notes' }, 'title');
  const before = canonicalJson(a.session.content);
  a.controller.edit(
    restoreAnalysisInputs(a.session.content, a.session.content.runs[0].id),
    'Restore inputs',
  );
  a.session.undo();
  expect(canonicalJson(a.session.content)).toBe(before);
  a.revoke();
  expect(() =>
    a.controller.edit(
      restoreAnalysisInputs(a.session.content, a.session.content.runs[0].id),
      'Restore inputs',
    ),
  ).toThrow('read-only');
});
