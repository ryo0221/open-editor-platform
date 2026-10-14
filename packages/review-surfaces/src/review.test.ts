import { expect, it } from 'vitest';
import {
  createFile,
  lineDiff,
  createReview,
  replaceComparison,
  reviewRevision,
  reviewAnchorState,
  originalBytes,
} from './model';
import { EditorSession, type ElementAddress } from '@editor-platform/editor-core';
it('computes context, added and removed lines with source numbers', () => {
  const lines = lineDiff('same\nold\nend', 'same\nnew\nend');
  expect(lines.filter((l) => l.type === 'context')).toHaveLength(2);
  expect(lines.find((l) => l.type === 'removed')).toMatchObject({ oldLine: 2, text: 'old' });
  expect(lines.find((l) => l.type === 'added')).toMatchObject({ newLine: 2, text: 'new' });
});
it('keeps old and new source revisions separate and returns to the original anchor on Undo', () => {
  const d = createReview(),
    file = d.files[0],
    session = new EditorSession(d);
  const old: ElementAddress = {
    artifactId: 'review',
    elementId: file.id,
    region: {
      type: 'lines',
      side: 'old',
      start: 2,
      end: 2,
      revisionId: reviewRevision(file, 'old'),
    },
  };
  const newer: ElementAddress = {
    ...old,
    region: {
      type: 'lines',
      side: 'new',
      start: 2,
      end: 2,
      revisionId: reviewRevision(file, 'new'),
    },
  };
  const edit = replaceComparison(file.id, 'deleted comparison', file.newText);
  session.execute(edit);
  expect(reviewAnchorState(session.content, old)).toBe('Outdated');
  expect(reviewAnchorState(session.content, newer)).toBe('Current');
  expect(edit.apply(d)).toEqual(session.content);
  session.undo();
  expect(reviewAnchorState(session.content, old)).toBe('Current');
  expect(reviewAnchorState({ ...d, files: [] }, old)).toBe('Orphan');
});
it('diffs 10,000 lines without replacing unchanged sources and reconstructs both sides', () => {
  const before = Array.from({ length: 10000 }, (_, i) => `export const 値${i} = ${i};`);
  const after = [...before];
  after.splice(50, 2, 'const 一つ = 1;');
  after.splice(9500, 0, 'const 最後 = 2;');
  const diff = lineDiff(before.join('\n'), after.join('\n'));
  expect(diff.filter((l) => l.type === 'removed')).toHaveLength(2);
  expect(diff.filter((l) => l.type === 'added')).toHaveLength(2);
  expect(diff.filter((l) => l.type !== 'added').map((l) => l.text)).toEqual(before);
  expect(diff.filter((l) => l.type !== 'removed').map((l) => l.text)).toEqual(after);
  expect(lineDiff('', '')).toEqual([]);
  expect(lineDiff('削除\n全部', '').map((l) => l.oldLine)).toEqual([1, 2]);
});
it('downloads original text bytes including BOM and CRLF without reencoding the display text', () => {
  const bytes = new TextEncoder().encode('\ufeff日本語\r\nsecond\r\n');
  const file = {
    ...createFile(),
    data: '日本語\nsecond\n',
    originalData: `data:text/plain;base64,${btoa(String.fromCharCode(...bytes))}`,
  };
  expect(originalBytes(file)).toEqual(bytes);
});
it('creates ordinary text, image and valid PDF demo payloads', () => {
  expect(createFile().data).toContain('Ready to review');
  expect(createFile('image').data).toMatch(/^data:image\/svg\+xml;base64,/);
  const pdf = atob(createFile('pdf').data.split(',')[1]);
  expect(pdf).toContain('%PDF-1.4');
  expect(pdf).toContain('xref');
  expect(pdf).toContain('%%EOF');
});
