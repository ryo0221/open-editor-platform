import { canonicalJson } from '@editor-platform/artifact-core';
import { command, transaction, type EditorCommand } from '@editor-platform/editor-core';
import { CalculationError } from '@editor-platform/calculation-core';
import {
  validateData,
  type StructuredData,
  type Cell,
} from '@editor-platform/structured-data/model';
import { guardDataCommand } from '@editor-platform/structured-data/session';
import { defaultView } from '@editor-platform/structured-data/views';
import type { Calculation, WorkResult } from '@editor-platform/estimate-core';

export const workColumns = [
  { id: 'task', name: '工程', type: 'text' },
  { id: 'start', name: '開始日', type: 'date' },
  { id: 'end', name: '最終稼働日', type: 'date' },
  { id: 'hours', name: '工数(hour)', type: 'text' },
  { id: 'days', name: '稼働日数', type: 'number' },
  { id: 'kind', name: '種類', type: 'text' },
  { id: 'basis', name: '計算根拠', type: 'text' },
] as const;
export interface WorkPublicationReceipt {
  sourceArtifactId: string;
  targetArtifactId: string;
  requestId: string;
  basisHash: string;
  rows: { taskId: string; rowId: string; values: Record<string, Cell> }[];
}
function values(task: WorkResult, basisHash: string): Record<string, Cell> {
  return {
    task: task.name,
    start: task.start,
    end: task.lastWorkingDate,
    hours: task.effortHours,
    days: task.durationWorkdays,
    kind: task.kind,
    basis: basisHash,
  };
}
/** Called only for a verified successful calculation. Dates use Timeline's inclusive end. */
export function initialWorkPublication(
  sourceArtifactId: string,
  targetArtifactId: string,
  requestId: string,
  calculation: Calculation,
) {
  if (!calculation.result.work || calculation.result.total === null)
    throw new CalculationError('missing-work-result');
  const rows = calculation.result.work.map((task) => ({
    taskId: task.id,
    rowId: JSON.stringify(['estimate-task', sourceArtifactId, task.id]),
    values: values(task, calculation.basisHash),
  }));
  const content: StructuredData = {
    schemaVersion: 2,
    columns: [
      ...workColumns.map((c) => ({ ...c })),
      { id: 'assignee', name: '担当', type: 'text' },
      { id: 'notes', name: '備考', type: 'text' },
    ],
    rows: rows.map((row) => ({
      id: row.rowId,
      values: { ...row.values, assignee: '', notes: '' },
    })),
  };
  const view = defaultView(content);
  view.id = 'estimate-work-timeline';
  view.name = '工程';
  view.projection = 'Timeline';
  view.timeline = { ...view.timeline, start: 'start', end: 'end' };
  content.views = [view];
  const receipt: WorkPublicationReceipt = {
    sourceArtifactId,
    targetArtifactId,
    requestId,
    basisHash: calculation.basisHash,
    rows,
  };
  return { content, receipt };
}
const preparedPublications = new WeakMap<WorkPublicationProposal, string>();
export interface WorkPublicationConflict {
  taskId: string;
  rowId: string;
  fieldId: string;
  reason: string;
}
export interface WorkPublicationProposal {
  content: StructuredData;
  receipt: WorkPublicationReceipt;
  conflicts: WorkPublicationConflict[];
  changes: { taskId: string; kind: 'added' | 'updated' | 'removed' | 'unchanged' }[];
}
/** Three-way comparison: previous publication / user's current Data / new calculated proposal. */
export function proposeWorkPublication(
  current: StructuredData,
  receipt: WorkPublicationReceipt,
  calculation: Calculation,
  requestId: string,
): WorkPublicationProposal {
  if (!calculation.result.work || calculation.result.total === null)
    throw new CalculationError('missing-work-result');
  if (validateData(current).length) throw new CalculationError('invalid-publication-data');
  if (
    !receipt.sourceArtifactId ||
    !receipt.targetArtifactId ||
    !receipt.requestId ||
    new Set(receipt.rows.map((r) => r.taskId)).size !== receipt.rows.length ||
    new Set(receipt.rows.map((r) => r.rowId)).size !== receipt.rows.length
  )
    throw new CalculationError('invalid-publication-receipt');
  for (const column of workColumns)
    if (!current.columns.some((c) => c.id === column.id && c.type === column.type && !c.readOnly))
      throw new CalculationError('publication-schema-conflict', column.id);
  const content = structuredClone(current),
    conflicts: WorkPublicationConflict[] = [],
    changes: WorkPublicationProposal['changes'] = [],
    nextRows: WorkPublicationReceipt['rows'] = [];
  const taskMap = new Map(calculation.result.work.map((t) => [t.id, t]));
  for (const prior of receipt.rows) {
    const row = content.rows.find((r) => r.id === prior.rowId),
      task = taskMap.get(prior.taskId);
    if (!row) {
      conflicts.push({
        taskId: prior.taskId,
        rowId: prior.rowId,
        fieldId: '',
        reason: '公開先の行が削除されています。推測で再作成しません。',
      });
      continue;
    }
    const next = task ? values(task, calculation.basisHash) : null;
    const changed = workColumns.filter(
      (c) => canonicalJson(row.values[c.id] ?? null) !== canonicalJson(prior.values[c.id] ?? null),
    );
    if (!task) {
      const extra = Object.entries(row.values).some(
        ([key, value]) => !workColumns.some((c) => c.id === key) && value !== null && value !== '',
      );
      if (changed.length || extra)
        conflicts.push({
          taskId: prior.taskId,
          rowId: prior.rowId,
          fieldId: '',
          reason: '削除対象に利用者の編集があります。',
        });
      else {
        content.rows = content.rows.filter((r) => r.id !== row.id);
        changes.push({ taskId: prior.taskId, kind: 'removed' });
      }
      continue;
    }
    for (const column of changed)
      if (canonicalJson(row.values[column.id] ?? null) !== canonicalJson(next![column.id]))
        conflicts.push({
          taskId: task.id,
          rowId: row.id,
          fieldId: column.id,
          reason: '前回公開後に管理対象fieldが変更されています。',
        });
    changes.push({
      taskId: task.id,
      kind: canonicalJson(prior.values) === canonicalJson(next) ? 'unchanged' : 'updated',
    });
    row.values = { ...row.values, ...next };
    nextRows.push({ taskId: task.id, rowId: row.id, values: next! });
    taskMap.delete(task.id);
  }
  for (const task of taskMap.values()) {
    if (receipt.rows.some((r) => r.taskId === task.id)) continue;
    const rowId = JSON.stringify(['estimate-task', receipt.sourceArtifactId, task.id]);
    if (content.rows.some((r) => r.id === rowId)) {
      conflicts.push({
        taskId: task.id,
        rowId,
        fieldId: '',
        reason: '新しいtaskの行IDが既存行と競合しています。',
      });
      continue;
    }
    const v = values(task, calculation.basisHash);
    content.rows.push({ id: rowId, values: v });
    nextRows.push({ taskId: task.id, rowId, values: v });
    changes.push({ taskId: task.id, kind: 'added' });
  }
  const proposal: WorkPublicationProposal = {
    content,
    receipt: { ...receipt, requestId, basisHash: calculation.basisHash, rows: nextRows },
    conflicts,
    changes,
  };
  preparedPublications.set(proposal, canonicalJson(proposal));
  return proposal;
}
export function applyWorkPublication(
  expected: StructuredData,
  proposal: WorkPublicationProposal,
  guard: () => boolean,
): EditorCommand<StructuredData> {
  if (preparedPublications.get(proposal) !== canonicalJson(proposal))
    throw new CalculationError('unverified-publication');
  if (proposal.conflicts.length) throw new CalculationError('publication-conflict');
  const before = canonicalJson(expected),
    next = structuredClone(proposal.content);
  return transaction(
    'Update estimated work plan',
    [
      guardDataCommand(
        command('estimate.publish-work', 'Update estimated work plan', (current) => {
          if (!guard()) throw new CalculationError('publication-access-or-input-denied');
          if (canonicalJson(current) !== before) throw new CalculationError('stale-publication');
          return structuredClone(next);
        }),
        guard,
      ),
    ],
    { origin: 'proposal', transactionId: proposal.receipt.requestId },
  );
}
/** Host-owned persistence and retry boundary; the Surface holds only an ephemeral preview. */
export interface WorkPublicationPreview {
  targetArtifactId: string;
  changes: string[];
  conflicts: string[];
  apply(): Promise<void>;
}
export interface WorkPublicationHost {
  prepare(calculation: Calculation): Promise<WorkPublicationPreview>;
  openTarget?(): void;
}
