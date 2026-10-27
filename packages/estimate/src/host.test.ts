import { expect, it } from 'vitest';
import { canonicalJson, createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { calculateEstimate, type EstimateDocument } from '@editor-platform/estimate-core';
import { estimateFixture } from '../../estimate-core/src/fixtures';
import {
  EstimateController,
  verifyEstimateArtifact,
  type EstimatePort,
  type EstimateWorkerFactory,
} from './host';
const testWorker: EstimateWorkerFactory = () => {
  const worker = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null,
    terminate() {},
    postMessage(m: { id: string; document: EstimateDocument; scenarioId: string | null }) {
      void calculateEstimate(m.document, m.id, m.scenarioId)
        .then((result) => worker.onmessage?.({ data: { id: m.id, result } }))
        .catch((e) => worker.onmessage?.({ data: { id: m.id, error: String(e) } }));
    },
  };
  return worker as unknown as Worker;
};
function fixture() {
  const session = new EditorSession(estimateFixture());
  let editable = true,
    ready = true,
    generation = 0,
    exportable = true;
  const port: EstimatePort = {
    read: () => session.content,
    revision: () => canonicalJson(session.revision),
    generation: () => generation,
    canEdit: () => editable,
    canRead: () => true,
    inputsReady: () => ready,
    canExport: () => exportable,
    flush() {},
    execute: (c) => {
      session.execute(c);
    },
  };
  return {
    session,
    port,
    controller: new EstimateController(port, testWorker),
    pending: () => {
      ready = false;
    },
    revoke: () => {
      editable = false;
      generation++;
    },
    denyExport: () => {
      exportable = false;
      generation++;
    },
  };
}
it('ES01/06 preview is immutable, apply is one Undo, Redo restores, and edit/Undo invalidates previews', async () => {
  const { controller, session } = fixture(),
    before = canonicalJson(session.content);
  const candidate = await controller.prepare();
  expect(canonicalJson(session.content)).toBe(before);
  controller.apply(candidate);
  expect(session.content.calculations[0].result.total).toBe('1350');
  session.undo();
  expect(canonicalJson(session.content)).toBe(before);
  session.redo();
  expect(session.content.calculations).toHaveLength(1);
  const other = await controller.prepare();
  controller.edit({ ...session.content, title: 'changed' });
  session.undo();
  expect(() => controller.apply(other)).toThrow('stale-result');
});
it('ES07 rechecks input, read-only, export and candidate integrity at trusted boundaries', async () => {
  const a = fixture(),
    pending = await a.controller.prepare();
  a.pending();
  expect(() => a.controller.apply(pending)).toThrow('input-pending');
  const b = fixture(),
    revoked = await b.controller.prepare();
  b.revoke();
  expect(() => b.controller.apply(revoked)).toThrow('read-only');
  const c = fixture(),
    tampered = await c.controller.prepare();
  tampered.document.title = 'forged';
  expect(() => c.controller.apply(tampered)).toThrow('unverified-candidate');
  await c.controller.run();
  c.denyExport();
  await expect(
    c.controller.verifiedCalculation(c.session.content.calculations[0].id),
  ).rejects.toThrow('export-denied');
});
it('ES06 cancellation, close, delayed duplicate completion preserve edits and previous success', async () => {
  const { controller, session, port } = fixture();
  await controller.run();
  const before = canonicalJson(session.content);
  let worker!: Worker,
    requestId = '';
  const delayed = new EstimateController(port, () => {
    worker = {
      onmessage: null,
      onerror: null,
      terminate() {},
      postMessage(m: { id: string }) {
        requestId = m.id;
      },
    } as unknown as Worker;
    return worker;
  });
  const completion = delayed.run();
  delayed.close();
  await expect(completion).rejects.toThrow('cancelled');
  const event = {
    data: { id: requestId, result: session.content.calculations[0] },
  } as MessageEvent;
  worker.onmessage?.(event);
  worker.onmessage?.(event);
  expect(canonicalJson(session.content)).toBe(before);
  await expect(delayed.run()).rejects.toThrow('closed');
});
it('ES05 validates every retained immutable version even if the current draft has no calculations', async () => {
  const doc = estimateFixture();
  doc.calculations.push(await calculateEstimate(doc, 'result'));
  const artifact = await commitVersion(
    createArtifact('estimate', 'Estimate', doc),
    'local',
    'fixture',
  );
  artifact.draft.content = estimateFixture();
  await expect(verifyEstimateArtifact(artifact)).resolves.toBeUndefined();
  const tampered = structuredClone(artifact);
  tampered.versions[0].content.calculations[0].result.total = '1';
  await expect(verifyEstimateArtifact(tampered)).rejects.toThrow('unverified-result');
});
it.each(['edit', 'undo', 'revoke', 'rerun'] as const)(
  'ES06 late completion after %s cannot overwrite successful results',
  async (action) => {
    const f = fixture();
    await f.controller.run();
    let worker!: Worker,
      message!: { id: string; document: EstimateDocument; scenarioId: string | null };
    const delayed = new EstimateController(f.port, () => {
      worker = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(m: typeof message) {
          message = m;
        },
      } as unknown as Worker;
      return worker;
    });
    const pending = delayed.run();
    const completion = calculateEstimate(message.document, message.id, message.scenarioId);
    if (action === 'edit') f.controller.edit({ ...f.session.content, title: 'Keep my edit' });
    if (action === 'undo') f.session.undo();
    if (action === 'revoke') f.revoke();
    if (action === 'rerun') await f.controller.run();
    const before = canonicalJson(f.session.content);
    worker.onmessage?.({ data: { id: message.id, result: await completion } } as MessageEvent);
    await expect(pending).rejects.toThrow();
    expect(canonicalJson(f.session.content)).toBe(before);
  },
);
it.each([null, { id: 'other' }])(
  'ES06 malformed worker completion terminates once and keeps history',
  async (data) => {
    const f = fixture();
    await f.controller.run();
    const before = canonicalJson(f.session.content);
    let worker!: Worker,
      terminated = 0;
    const controller = new EstimateController(f.port, () => {
      worker = {
        onmessage: null,
        onerror: null,
        terminate() {
          terminated++;
        },
        postMessage() {},
      } as unknown as Worker;
      return worker;
    });
    const pending = controller.run();
    worker.onmessage?.({ data } as MessageEvent);
    worker.onmessage?.({ data } as MessageEvent);
    await expect(pending).rejects.toThrow('worker-request-mismatch');
    expect(terminated).toBe(1);
    expect(canonicalJson(f.session.content)).toBe(before);
  },
);
it('construction retention is explicit, preview/failed execution keep history, replacement is one Undo', async () => {
  const { controller, session } = fixture();
  for (let i = 0; i < 5; i++) await controller.run();
  const before = canonicalJson(session.content);
  await expect(controller.prepare()).rejects.toThrow('計算記録は5件');
  expect(canonicalJson(session.content)).toBe(before);
  const next = await controller.prepare(null, undefined, 'replace');
  expect(canonicalJson(session.content)).toBe(before);
  expect(next.document.calculations).toHaveLength(1);
  controller.apply(next);
  expect(session.content.calculations).toHaveLength(1);
  session.undo();
  expect(canonicalJson(session.content)).toBe(before);
  session.redo();
  expect(session.content.calculations).toHaveLength(1);
});
it('replacement cannot erase success when validation fails or access is revoked', async () => {
  const f = fixture();
  await f.controller.run();
  const before = canonicalJson(f.session.content),
    invalid = f.session.content;
  invalid.rates[0].unitPrice = null;
  await expect(f.controller.prepare(null, invalid, 'replace')).rejects.toThrow();
  expect(canonicalJson(f.session.content)).toBe(before);
  const candidate = await f.controller.prepare(null, undefined, 'replace');
  f.revoke();
  expect(() => f.controller.apply(candidate)).toThrow();
  expect(canonicalJson(f.session.content)).toBe(before);
});
