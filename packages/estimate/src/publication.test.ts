import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { calculateEstimate } from '@editor-platform/estimate-core';
import { estimateFixture } from '../../estimate-core/src/fixtures';
import {
  initialWorkPublication,
  proposeWorkPublication,
  applyWorkPublication,
} from './publication';
async function fixture() {
  const doc = estimateFixture();
  doc.workRules = [
    {
      id: 'r',
      name: 'Assembly',
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
    tasks: [{ id: 'bolt-task', name: 'Assembly', lineId: 'line-bolt', ruleId: 'r' }],
    dependencies: [],
  };
  const calculation = await calculateEstimate(doc, 'first');
  return {
    doc,
    calculation,
    ...initialWorkPublication('source', 'target', 'request1', calculation),
  };
}
it('ES24/27 creates inclusive Timeline dates and preserves unmanaged user fields in one Undo', async () => {
  const { doc, content, receipt } = await fixture();
  expect(content.rows[0].values).toMatchObject({
    start: '2026-10-30',
    end: '2026-11-02',
    hours: '12',
    days: 2,
  });
  expect(content.views![0].timeline).toMatchObject({ start: 'start', end: 'end' });
  content.rows[0].values.notes = 'human note';
  doc.workRules[0].hoursPerUnit = '4';
  const next = await calculateEstimate(doc, 'next'),
    proposal = proposeWorkPublication(content, receipt, next, 'request2');
  expect(proposal.conflicts).toEqual([]);
  expect(content.rows[0].values.hours).toBe('12');
  const session = new EditorSession(content);
  session.execute(applyWorkPublication(content, proposal, () => true));
  expect(session.content.rows[0].values).toMatchObject({
    hours: '24',
    notes: 'human note',
    end: '2026-11-03',
  });
  session.undo();
  expect(session.content).toEqual(content);
  const afterUndo = proposeWorkPublication(session.content, proposal.receipt, next, 'retry');
  expect(afterUndo.conflicts.length).toBeGreaterThan(0);
});
it('ES24/26 refuses edited managed cells, row deletion, and deletion of a source task with human edits', async () => {
  const { doc, content, receipt } = await fixture();
  content.rows[0].values.start = '2026-11-09';
  const next = await calculateEstimate(doc, 'next'),
    proposal = proposeWorkPublication(content, receipt, next, 'r2');
  expect(proposal.conflicts.some((c) => c.fieldId === 'start')).toBe(true);
  expect(() => applyWorkPublication(content, proposal, () => true)).toThrow('publication-conflict');
  const missing = { ...content, rows: [] };
  expect(proposeWorkPublication(missing, receipt, next, 'r3').conflicts).toHaveLength(1);
  doc.workPlan!.tasks = [];
  const removed = await calculateEstimate(doc, 'removed');
  expect(proposeWorkPublication(content, receipt, removed, 'r4').conflicts).toHaveLength(1);
});
it('ES07/24 apply rejects permission loss, stale current content and proposal tampering', async () => {
  const { content, receipt, calculation } = await fixture();
  const proposal = proposeWorkPublication(content, receipt, calculation, 'retry');
  expect(() => applyWorkPublication(content, proposal, () => false).apply(content)).toThrow();
  const cmd = applyWorkPublication(content, proposal, () => true),
    changed = structuredClone(content);
  changed.rows[0].values.notes = 'late edit';
  expect(() => cmd.apply(changed)).toThrow('stale-publication');
  proposal.content.rows[0].values.hours = '999';
  expect(() => applyWorkPublication(content, proposal, () => true)).toThrow(
    'unverified-publication',
  );
});
