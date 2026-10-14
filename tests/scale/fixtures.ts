import { createArtifact } from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document';
import type { StructuredData } from '@editor-platform/structured-data';
import type { SlideContent } from '@editor-platform/slide';
import type { DesignContent } from '@editor-platform/design';
import type { WhiteboardContent } from '@editor-platform/whiteboard';
import type { ReviewContent } from '@editor-platform/review-surfaces';
const bounds = (i: number) => ({
  x: 30 + (i % 10) * 140,
  y: 30 + Math.floor(i / 10) * 90,
  width: 120,
  height: 60,
});
const text = '日本語を含む実用規模の検証。入力と選択、文章の流れを確認します。';
export function scaleArtifact(kind: string) {
  let content: unknown;
  if (kind === 'slide')
    content = {
      schemaVersion: 2,
      width: 1600,
      height: 900,
      slides: Array.from({ length: 50 }, (_, p) => ({
        id: `page-${p}`,
        title: `Page ${p + 1}`,
        background: '#ffffff',
        objects: Array.from({ length: 20 }, (_, i) => ({
          id: `p${p}-object-${i}`,
          type: i % 4 ? 'text' : 'shape',
          shape: 'rectangle',
          text: `内容 ${p + 1}.${i + 1}`,
          fill: i % 4 ? '#263246' : '#dceafa',
          bounds: bounds(i),
          typography: { fontSize: 14 },
        })),
      })),
    } satisfies SlideContent;
  if (kind === 'design')
    content = {
      schemaVersion: 2,
      components: [],
      elements: Array.from({ length: 10 }, (_, f) => {
        const x = (f % 5) * 1700,
          y = Math.floor(f / 5) * 900;
        return [
          {
            id: `frame-${f}`,
            type: 'frame' as const,
            name: `Frame ${f}`,
            text: '',
            fill: '#ffffff',
            bounds: { x, y, width: 1600, height: 800 },
            clipContent: true,
          },
          ...Array.from({ length: 49 }, (_, i) => ({
            id: `f${f}-object-${i}`,
            parentId: `frame-${f}`,
            type: 'text' as const,
            name: `Label ${f}.${i}`,
            text: `項目 ${i}`,
            fill: '#263246',
            bounds: { ...bounds(i), x: x + bounds(i).x, y: y + bounds(i).y },
            typography: { fontSize: 14 },
          })),
        ];
      }).flat(),
    } satisfies DesignContent;
  if (kind === 'whiteboard')
    content = {
      schemaVersion: 3,
      sections: [
        {
          id: 'section',
          title: 'Load study',
          background: '#eef4ff',
          bounds: { x: -20, y: -20, width: 2900, height: 2500 },
        },
      ],
      nodes: Array.from({ length: 500 }, (_, i) => ({
        id: `node-${i}`,
        kind: i % 25 === 0 ? ('group' as const) : ('sticky' as const),
        ...(i % 25 ? { groupId: `node-${i - (i % 25)}` } : { sectionId: 'section' }),
        text: `付箋 ${i}`,
        color: '#ffe69b',
        bounds: { x: (i % 20) * 140, y: Math.floor(i / 20) * 90, width: 120, height: 70 },
        typography: { fontSize: 14 },
      })),
      connectors: Array.from({ length: 100 }, (_, i) => ({
        id: `connector-${i}`,
        from: `node-${i * 2 + 1}`,
        to: `node-${i * 2 + 2}`,
        label: `接続 ${i}`,
      })),
    } satisfies WhiteboardContent;
  if (kind === 'document')
    content = {
      schemaVersion: 2,
      blocks: Array.from({ length: 200 }, (_, i) =>
        i % 40 === 0
          ? {
              id: `block-${i}`,
              type: 'table' as const,
              text: '',
              cells: [
                ['項目', '結果'],
                ['入力', '確認'],
                ['保存', '完了'],
              ],
            }
          : i % 40 === 1
            ? {
                id: `block-${i}`,
                type: 'image' as const,
                text: '',
                alt: 'Scale fixture image',
                width: 160,
                src:
                  'data:image/svg+xml;base64,' +
                  Buffer.from(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="#3978c6"/></svg>',
                  ).toString('base64'),
              }
            : {
                id: `block-${i}`,
                type: i % 10 === 0 ? ('heading' as const) : ('paragraph' as const),
                level: 2,
                text: `${i}. ${text.repeat(3)}`,
              },
      ),
    } satisfies DocumentContent;
  if (kind === 'data')
    content = {
      schemaVersion: 2,
      columns: Array.from({ length: 20 }, (_, i) => ({
        id: `field-${i}`,
        name: i ? `Metric ${i}` : 'Name',
        type: i ? ('number' as const) : ('text' as const),
      })),
      rows: Array.from({ length: 5000 }, (_, r) => ({
        id: `record-${r}`,
        values: Object.fromEntries(
          Array.from({ length: 20 }, (_, c) => [`field-${c}`, c ? r + c : `案件 ${r}`]),
        ),
      })),
    } satisfies StructuredData;
  if (kind === 'review')
    content = {
      schemaVersion: 2,
      files: Array.from({ length: 3 }, (_, f) => ({
        id: `file-${f}`,
        name: `large-${f}.ts`,
        oldRevision: `before-${f}`,
        newRevision: `after-${f}`,
        oldText: Array.from(
          { length: f === 2 ? 3334 : 3333 },
          (_, i) => `const value${i} = ${i}; // 日本語`,
        ).join('\n'),
        newText: Array.from(
          { length: f === 2 ? 3334 : 3333 },
          (_, i) => `const value${i} = ${i % 100 === 0 ? i + 1 : i}; // 日本語`,
        ).join('\n'),
      })),
    } satisfies ReviewContent;
  if (!content) throw new Error(`Unknown scale fixture: ${kind}`);
  return { ...createArtifact(kind, `Scale ${kind}`, content), annotations: [] };
}
