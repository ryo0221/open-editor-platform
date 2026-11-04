/** One owner's explicit exact-reference manifest, applied as one native command. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { LocalDraftRevision } from '@editor-platform/editor-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { timelineCommand, TimelineEditError, type TimelineRowInput } from './commands';
import { isVerifiedRows, type VerifiedTimelineRows } from './refs';
import type { TimelineRole } from './table';
export interface TimelineExactRef {
  artifact: string;
  version: string;
  hash: string;
  item: string;
  facet?: string;
}
export interface TimelineRepinManifest {
  owner: string;
  baseVersion: string | null;
  baseLocalRevision: LocalDraftRevision;
  rows: { row: string; ref: 'ref' | 'ref2'; old: TimelineExactRef; new: TimelineExactRef }[];
}
export function exactRefCells(
  values: TimelineRowInput['values'],
  ref: 'ref' | 'ref2',
): TimelineExactRef | undefined {
  const prefix = 'tl1.' + ref + '.';
  if (!values[prefix + 'artifact']) return;
  return Object.fromEntries(
    ['artifact', 'version', 'hash', 'item', 'facet'].flatMap((k) =>
      typeof values[prefix + k] === 'string' ? [[k, values[prefix + k]]] : [],
    ),
  ) as unknown as TimelineExactRef;
}
/** Builds only changed rows for the existing exact validator; no owner or storage write. */
export function repinRows(
  data: StructuredData,
  manifest: TimelineRepinManifest,
): TimelineRowInput[] {
  if (!manifest.rows.length) throw new TimelineEditError('再固定する参照を選んでください。');
  const rows = new Map<string, TimelineRowInput>(),
    seen = new Set<string>();
  for (const change of manifest.rows) {
    const key = JSON.stringify([change.row, change.ref]);
    if (!['ref', 'ref2'].includes(change.ref) || seen.has(key))
      throw new TimelineEditError('同じ参照を二重に指定できません。');
    seen.add(key);
    const source = data.rows.find((r) => r.id === change.row);
    if (
      !source ||
      canonicalJson(
        exactRefCells(source.values as TimelineRowInput['values'], change.ref) ?? null,
      ) !== canonicalJson(change.old)
    )
      throw new TimelineEditError('旧参照が変わりました。再読込して準備してください。');
    const row = rows.get(change.row) ?? (structuredClone(source) as TimelineRowInput);
    for (const k of ['artifact', 'version', 'hash', 'item', 'facet'])
      delete row.values['tl1.' + change.ref + '.' + k];
    for (const [k, v] of Object.entries(change.new)) {
      if (!['artifact', 'version', 'hash', 'item', 'facet'].includes(k))
        throw new TimelineEditError('参照以外の変更は含められません。');
      row.values['tl1.' + change.ref + '.' + k] = v;
    }
    rows.set(row.id, row);
  }
  return [...rows.values()];
}
export function repinCommand(
  role: TimelineRole,
  manifest: TimelineRepinManifest,
  verified: VerifiedTimelineRows,
) {
  if (!isVerifiedRows(verified)) throw new TimelineEditError('新しい保存版を検証してください。');
  const captured = structuredClone(manifest);
  const key = (rows: readonly TimelineRowInput[]) =>
    canonicalJson([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  return timelineCommand(role, 'timeline.repin', '確認した参照を一括再固定', (data) => {
    if (verified.targets.some((id) => !verified.mayRead(id)))
      throw new TimelineEditError('参照先を読めなくなりました。');
    const rows = repinRows(data, captured);
    if (key(rows) !== key(verified.rows))
      throw new TimelineEditError('検証した参照と候補が一致しません。');
    const next = new Map(rows.map((r) => [r.id, r]));
    data.rows = data.rows.map((r) =>
      next.has(r.id) ? (structuredClone(next.get(r.id)!) as StructuredData['rows'][number]) : r,
    );
  });
}
