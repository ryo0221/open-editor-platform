import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJson, createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { calculateEstimate } from '@editor-platform/estimate-core';
import { estimateFixture } from '../../../../packages/estimate-core/src/fixtures';
import type { EstimatePort } from '@editor-platform/estimate';
import type { SurfaceHost } from './editor-surfaces';
import type { StoredArtifact } from '../model';
vi.mock('./records', async () => {
  const { MemoryStorage } = await import('@editor-platform/artifact-core');
  return {
    storage: new MemoryStorage(),
    editedDraft: (a: StoredArtifact, content: unknown) => ({
      ...a,
      draft: { ...a.draft, content },
    }),
  };
});
vi.mock('../model', async () => {
  const { EditorSession } = await import('@editor-platform/editor-core');
  return { createLocalSession: (content: unknown) => new EditorSession(content) };
});
import { estimateWorkPublication } from './estimate-publication';
import { storage } from './records';
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  for (const a of await storage.list()) await storage.remove(a.id);
  const ledger = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => ledger.get(key) ?? null,
    setItem: (key: string, value: string) => ledger.set(key, value),
  });
  const doc = estimateFixture();
  doc.workRules = [
    {
      id: 'crew',
      name: 'Crew',
      setupHours: '0',
      hoursPerUnit: '2',
      perUnit: 'count',
      crewCount: 1,
      hoursPerDay: '8',
    },
  ];
  doc.workPlan = {
    projectStartDate: '2026-10-30',
    calendar: { weekdays: [1, 2, 3, 4, 5], exceptions: [] },
    tasks: [{ id: 'task', name: 'Assembly', lineId: 'line-bolt', ruleId: 'crew' }],
    dependencies: [],
  };
  const calculation = await calculateEstimate(doc, 'run');
  doc.calculations = [calculation];
  const source = {
    ...(await commitVersion(createArtifact('estimate', 'Source', doc), 'test', 'Test publication')),
    annotations: [],
  };
  const session = new EditorSession(doc);
  let fail = false,
    editable = true;
  const host = {
    active: source,
    shared: false,
    recordsRef: { current: [source] as StoredArtifact[] },
    savedRecords: { current: new Map<string, StoredArtifact>([[source.id, source]]) },
    sessions: {
      current: new Map<string, EditorSession<unknown>>([
        [source.id, session as EditorSession<unknown>],
      ]),
    },
    persist: async (artifact: StoredArtifact) => {
      if (fail) return false;
      await storage.put(artifact);
      host.recordsRef.current = [
        ...host.recordsRef.current.filter((a) => a.id !== artifact.id),
        artifact,
      ];
      host.savedRecords.current.set(artifact.id, artifact);
      return true;
    },
  };
  const port: EstimatePort = {
    read: () => session.content,
    revision: () => canonicalJson(session.revision),
    generation: () => 0,
    canRead: () => true,
    canEdit: () => editable,
    canExport: () => true,
    inputsReady: () => true,
    flush() {},
    execute: (cmd) => {
      session.execute(cmd);
    },
  };
  const publication = estimateWorkPublication(() => host as unknown as SurfaceHost, port);
  return {
    publication,
    calculation,
    host,
    ledger,
    fail: (value: boolean) => {
      fail = value;
    },
    revoke: () => {
      editable = false;
    },
  };
}
it('ES25 retries atomic creation after list-save failure without duplicating rows or artifacts', async () => {
  const f = await fixture();
  const first = await f.publication.prepare(f.calculation);
  f.fail(true);
  await expect(first.apply()).rejects.toThrow('未完了');
  expect((await storage.list()).length).toBe(1);
  f.fail(false);
  const retry = await f.publication.prepare(f.calculation);
  expect(retry.targetArtifactId).toBe(first.targetArtifactId);
  await retry.apply();
  expect((await storage.list()).length).toBe(1);
  expect((await f.publication.prepare(f.calculation)).changes).toEqual(['unchanged: task']);
  expect(f.host.savedRecords.current.get(f.host.active.id)?.versions[0].content).toEqual(
    f.host.active.versions[0].content,
  );
});
it('ES26 refuses missing receipts and permission loss at apply without overwriting Data', async () => {
  const f = await fixture();
  await (await f.publication.prepare(f.calculation)).apply();
  const before = await storage.list();
  const proposal = await f.publication.prepare(f.calculation);
  f.revoke();
  await expect(proposal.apply()).rejects.toThrow('権限');
  expect(await storage.list()).toEqual(before);
  const g = await fixture();
  await (await g.publication.prepare(g.calculation)).apply();
  g.ledger.clear();
  await expect(g.publication.prepare(g.calculation)).rejects.toThrow('receipt');
  expect((await storage.list()).length).toBe(1);
});
it('ES25 existing Data save failure is retried without a second transaction and keeps user notes', async () => {
  const f = await fixture();
  const first = await f.publication.prepare(f.calculation);
  await first.apply();
  const session = f.host.sessions.current.get(first.targetArtifactId)!;
  const initial = structuredClone(session.content) as {
    rows: { values: Record<string, unknown> }[];
  };
  initial.rows[0].values.notes = 'Keep this note';
  session.execute({ type: 'test-note', label: 'User note', apply: () => initial });
  // An unchanged calculation still publishes the user's draft as a new Data version.
  const candidate = await f.publication.prepare(f.calculation);
  f.fail(true);
  await expect(candidate.apply()).rejects.toThrow('保存未完了');
  const revision = canonicalJson(session.revision);
  const retry = await f.publication.prepare(f.calculation);
  expect(retry.conflicts).toEqual([]);
  f.fail(false);
  await retry.apply();
  expect(canonicalJson(session.revision)).toBe(revision);
  expect((session.content as typeof initial).rows[0].values.notes).toBe('Keep this note');
  expect((await storage.list()).length).toBe(1);
});
it('ES26 rejects a forged previous publication basis instead of hiding managed-field conflicts', async () => {
  const f = await fixture();
  await (await f.publication.prepare(f.calculation)).apply();
  const key = [...f.ledger.keys()][0];
  const ledger = JSON.parse(f.ledger.get(key)!);
  ledger.receipt.rows[0].values.start = '2030-01-01';
  f.ledger.set(key, JSON.stringify(ledger));
  await expect(f.publication.prepare(f.calculation)).rejects.toThrow('receipt-basis-mismatch');
});
