import type { DocumentContent } from '@editor-platform/document/model';
import type { ExportFontProfile, ExportAsset } from '@editor-platform/export-core';
import type { DocumentDocxOptions } from './types';
export const contractOptions: DocumentDocxOptions = {
  fontProfileId: 'test-body',
  styleProfileId: 'document-ja-1',
  mermaid: 'reject',
  previewBlocks: 'reject',
};
export const contractFont = (id: string): ExportFontProfile => ({
  id,
  family: id === 'test-body' ? 'Noto Sans CJK JP' : 'Noto Sans Mono CJK JP',
  version: '2.004',
  license: 'OFL-1.1',
  verified: true,
  faces: [
    { weight: 'regular', sha256: 'a'.repeat(64) },
    { weight: 'bold', sha256: 'b'.repeat(64) },
  ],
  glyphRanges: [[0, 0x10ffff]],
});
export const contractDocument = (): DocumentContent => ({
  schemaVersion: 2,
  page: { size: 'A4', margin: 64 },
  blocks: [
    { id: 'PRIVATE_HEADING', type: 'heading', level: 2, text: '日本語の提案書' },
    {
      id: 'PRIVATE_PARAGRAPH',
      type: 'paragraph',
      text: 'stale',
      rich: [
        { text: '文章  A\tB\n次の行', bold: true, color: '#245', highlight: '#eef' },
        { text: ' italic', italic: true, underline: true, strike: true },
        { text: '参照', link: 'https://example.com/path?a=1&b=2' },
      ],
    },
    {
      id: 'PRIVATE_TABLE',
      type: 'table',
      text: '',
      cells: [
        ['merged', 'ignored'],
        ['covered', 'fallback'],
      ],
      merges: [{ row: 0, col: 0, rows: 2, cols: 1 }],
      columnWidths: [160, 240],
      cellHeaders: [
        [false, false],
        [false, false],
      ],
      cellRich: [[[{ text: 'shadow' }], [{ text: 'rich winner' }]]],
      cellParagraphs: [
        [
          [
            { id: 'PRIVATE_CELL', rich: [{ text: '第一段落' }] },
            { id: 'PRIVATE_CELL_2', rich: [{ text: '第二段落', bold: true }] },
          ],
        ],
      ],
    },
    { id: 'PRIVATE_AFTER', type: 'paragraph', text: '表の後の最終段落' },
  ],
});
export function contractPng(): ExportAsset {
  return {
    bytes: Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ3kAAAAASUVORK5CYII=',
      ),
      (s) => s.charCodeAt(0),
    ),
    mime: 'image/png',
    width: 1,
    height: 1,
  };
}
