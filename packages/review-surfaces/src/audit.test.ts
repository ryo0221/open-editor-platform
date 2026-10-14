import { it, expect } from 'vitest';
import {
  createReview,
  assertReviewSelection,
  reviewRevision,
  replaceComparison,
  remapReviewAnnotation,
  remapFileAnnotation,
  reviewAddressRevision,
  reviewAnchorState,
} from './model';
import { addAnnotation } from '@editor-platform/editor-core';
import { decodeFileText } from './text-decode';
import { pdfTextMatches, pdfTextSearch } from './pdf-text';
it('decodes BOM UTF-16LE/BE and explicit Shift-JIS without modifying original bytes, rejects mismatched input clearly', () => {
  const le = Uint8Array.from([255, 254, 229, 101, 44, 103, 158, 138]);
  const be = Uint8Array.from([254, 255, 101, 229, 103, 44, 138, 158]);
  expect(decodeFileText(le, 'le.txt')).toBe('日本語');
  expect(decodeFileText(be, 'be.txt')).toBe('日本語');
  expect(
    decodeFileText(Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), 'sjis.txt', 'shift_jis'),
  ).toBe('日本語');
  expect(() => decodeFileText(Uint8Array.from([255]), 'invalid.txt')).toThrow(/invalid.txt.*UTF-8/);
  expect([...le]).toEqual([255, 254, 229, 101, 44, 103, 158, 138]);
});
it('rejects stale source and a current anchor on another visible file at submission', () => {
  const content = createReview(),
    file = content.files[0];
  const visible = {
    id: file.id,
    name: file.name,
    oldRevision: reviewRevision(file, 'old'),
    newRevision: reviewRevision(file, 'new'),
  };
  const address = {
    artifactId: 'artifact',
    elementId: file.id,
    region: {
      type: 'lines' as const,
      start: 1,
      end: 1,
      side: 'new' as const,
      revisionId: visible.newRevision,
    },
  };
  expect(() => assertReviewSelection(content, [address], visible, 'artifact')).not.toThrow();
  expect(() =>
    assertReviewSelection(content, [address], { ...visible, id: content.files[1].id }, 'artifact'),
  ).toThrow('表示中');
  expect(() =>
    assertReviewSelection(
      replaceComparison(file.id, file.oldText, '変更').apply(content),
      [address],
      visible,
      'artifact',
    ),
  ).toThrow();
});
it('finds Japanese phrases across extracted PDF runs and across multiple pages', () => {
  const pages = [
    { page: 1, text: '日本語本文', items: [] },
    { page: 2, text: '本文 日本語 本文', items: [] },
  ];
  expect(pdfTextMatches(pages, '本文').map((match) => [match.page, match.offset])).toEqual([
    [1, 3],
    [2, 0],
    [2, 7],
  ]);
});
it.each(['old', 'new'] as const)(
  'keeps the legacy %s annotation revision stable after source replacement',
  (side) => {
    const content = createReview(),
      file = content.files[0];
    const address = {
      artifactId: 'artifact',
      elementId: file.id,
      region: { type: 'lines' as const, start: 1, end: 1, side },
    };
    expect(reviewAddressRevision(address)).toBe(reviewRevision(file, side));
    expect(reviewAnchorState(content, address)).toBe('Current');
    const replaced = replaceComparison(file.id, 'changed old', 'changed new').apply(content);
    expect(reviewAnchorState(replaced, address)).toBe('Outdated');
    expect(reviewAddressRevision(address)).not.toBe(reviewRevision(replaced.files[0], side));
    expect(
      reviewAddressRevision({ ...address, region: { ...address.region, revisionId: 'explicit' } }),
    ).toBe('explicit');
  },
);
it.each([9999, 10000, 10001])(
  'reports PDF truncation only when more than the per-page limit matches exist (%i)',
  (count) => {
    const search = pdfTextSearch(
      [
        { page: 1, text: 'a '.repeat(count), items: [] },
        { page: 2, text: 'A end', items: [] },
      ],
      'a',
    );
    expect(search.truncated).toBe(count > 10000);
    expect(search.matches).toHaveLength(Math.min(count, 10000) + 1);
    expect(search.matches.at(-1)).toEqual({ page: 2, offset: 0, text: 'a' });
    expect(pdfTextSearch([{ page: 1, text: 'a '.repeat(count), items: [] }], 'end')).toEqual({
      matches: [],
      truncated: false,
    });
    expect(pdfTextSearch([], '')).toEqual({ matches: [], truncated: false });
  },
);
it('remaps an obsolete File ID without changing foreign references, additional anchors or annotation metadata', () => {
  const external = {
    artifactId: 'external',
    elementId: 'old',
    region: { type: 'lines' as const, start: 2, end: 2 },
  };
  const old = { ...external, artifactId: 'artifact' };
  const additional = { ...old, region: { ...old.region, start: 3, end: 3 } };
  const annotation = {
    ...addAnnotation({ addresses: [external, old, additional] }, 'Retained', 'Author'),
    color: '#123456',
    resolved: true,
  };
  const next = { ...old, elementId: 'new', region: { ...old.region, start: 1, end: 1 } };
  expect(remapFileAnnotation(annotation, next)).toEqual({
    ...annotation,
    anchor: { addresses: [external, next, additional] },
  });
  expect(annotation.anchor.addresses).toEqual([external, old, additional]);
  expect(() => remapFileAnnotation(annotation, { ...next, artifactId: 'missing' })).toThrow(
    '注釈対象',
  );
});
it('remaps only the displayed file anchor, preserving other files/artifacts and thread metadata', () => {
  const addresses = [
    {
      artifactId: 'artifact',
      elementId: 'B',
      region: { type: 'lines' as const, start: 1, end: 2, revisionId: 'old-B' },
    },
    {
      artifactId: 'artifact',
      elementId: 'A',
      region: { type: 'lines' as const, start: 1, end: 2, revisionId: 'old-A' },
    },
    {
      artifactId: 'external',
      elementId: 'A',
      region: { type: 'lines' as const, start: 1, end: 2, revisionId: 'external-A' },
    },
  ];
  const annotation = {
    ...addAnnotation({ addresses }, 'Multi-source', 'Author'),
    color: '#123456',
    resolved: true,
  };
  const replacement = {
    ...addresses[1],
    region: { type: 'lines' as const, start: 3, end: 3, revisionId: 'new-A' },
  };
  const remapped = remapReviewAnnotation(annotation, replacement);
  expect(remapped).toEqual({
    ...annotation,
    anchor: { addresses: [addresses[0], replacement, addresses[2]] },
  });
  expect(annotation.anchor.addresses).toEqual(addresses);
  expect(() => remapReviewAnnotation(annotation, { ...replacement, elementId: 'missing' })).toThrow(
    '注釈対象',
  );
});
