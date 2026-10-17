import { expect, it, vi } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { createDocumentTextMetrics } from './text-metrics';
import type { DocumentBlock } from './model';
it('matches whole-text counts for paragraphs, tables, Japanese and empty blocks', () => {
  const blocks: DocumentBlock[] = [
    { id: 'a', type: 'paragraph', text: '日本語の本文と English words.' },
    {
      id: 'b',
      type: 'table',
      text: '',
      cells: [
        ['A table', '日本語'],
        ['One', 'two'],
      ],
    },
    { id: 'c', type: 'paragraph', text: '' },
  ];
  const text = blocks
    .map((b) => (b.type === 'table' ? b.cells!.flat().join(' ') : b.text))
    .join(' ');
  const expected = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter(
    (s) => s.isWordLike,
  ).length;
  expect(createDocumentTextMetrics()(blocks)).toEqual({ words: expected, characters: text.length });
});
it('segments only changed owned blocks while observing mutable edits', () => {
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  try {
    const count = createDocumentTextMetrics();
    const first = deepFreeze([
      { id: 'a', type: 'paragraph' as const, text: 'One word' },
      { id: 'b', type: 'paragraph' as const, text: 'Second block' },
    ]);
    expect(count(first).words).toBe(4);
    segment.mockClear();
    expect(count(first).words).toBe(4);
    expect(segment).not.toHaveBeenCalled();
    const next = deepFreeze([{ ...first[0], text: 'One more word' }, first[1]]);
    expect(count(next).words).toBe(5);
    expect(segment).toHaveBeenCalledTimes(1);
    const mutable = { id: 'mutable', type: 'paragraph' as const, text: 'One' };
    expect(count([mutable]).words).toBe(1);
    mutable.text = 'One more';
    expect(count([mutable]).words).toBe(2);
  } finally {
    segment.mockRestore();
  }
});
