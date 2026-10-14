import { expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { captureDocumentExportSnapshot, prepareDocumentDocx, encodeDocumentDocx } from './index';
import { ownedDocumentDocxPlan } from './plan';
import { encodeOwnedDocx } from './docx-adapter';
import { contractDocument, contractFont, contractOptions, contractPng } from './fixtures';
import type { DocumentContent } from '@editor-platform/document/model';
import type { DocumentDocxOptions, DocxAdapters } from './types';
async function encoded(
  content = contractDocument(),
  options: DocumentDocxOptions = contractOptions,
  adapters: DocxAdapters = {},
) {
  const p = await prepareDocumentDocx(
    await captureDocumentExportSnapshot(content, {
      kind: 'saved-version',
      artifactId: 'PRIVATE_ARTIFACT',
      versionId: 'PRIVATE_VERSION',
    }),
    options,
    { resolveFont: async (id) => contractFont(id), ...adapters },
  );
  expect(p.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const result = await encodeOwnedDocx(ownedDocumentDocxPlan(p)!);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw Error('No output');
  const files = unzipSync(result.bytes);
  return { ...result, files, plan: p, xml: (name = 'word/document.xml') => strFromU8(files[name]) };
}
it('materialized named styles export in points with rich overrides and hidden content omitted', async () => {
  const r = await encoded({
    schemaVersion: 2,
    blocks: [
      {
        id: 'body',
        type: 'paragraph',
        text: '',
        styleName: '本文',
        style: {
          color: '#336699',
          fontFamily: 'Noto Sans CJK JP',
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1.5,
          spaceBefore: 6,
          spaceAfter: 12,
        },
        rich: [{ text: '氏名' }, { text: '部署', color: '#aa2200', bold: false }],
      },
      { id: 'hidden', type: 'paragraph', text: '非表示の内部本文', hidden: true },
    ],
  });
  const xml = r.xml();
  expect(xml).toContain('w:color w:val="336699"');
  expect(xml).toContain('w:color w:val="AA2200"');
  expect(xml).toContain('w:sz w:val="24"');
  expect(xml).toContain('w:before="120"');
  expect(xml).toContain('w:after="240"');
  expect(xml).toContain('w:line="360"');
  expect(xml).not.toContain('非表示の内部本文');
});
it('D01/D02/D04 native flow retains effective text, rich marks, whitespace, merges and complete mappings', async () => {
  const result = await encoded();
  const xml = result.xml();
  expect(xml).toContain('w:pStyle w:val="Heading2"');
  for (const text of [
    '日本語の提案書',
    '文章  A',
    '次の行',
    '第一段落',
    '第二段落',
    'rich winner',
    'fallback',
    '表の後の最終段落',
  ])
    expect(xml).toContain(text);
  for (const ignored of ['stale', 'shadow', 'covered', 'ignored', 'merged'])
    expect(xml).not.toContain(`>${ignored}<`);
  expect(xml).toContain('<w:tab/>');
  expect(xml).toContain('<w:cr/>');
  expect(xml).toContain('<w:b/>');
  expect(xml).toContain('<w:i/>');
  expect(xml).toContain('<w:strike/>');
  expect(xml).toContain('w:color w:val="224455"');
  expect(xml).toContain('w:fill="EEEEFF"');
  expect(xml).toContain('w:eastAsia="Noto Sans CJK JP"');
  expect(xml).toContain('<w:vMerge w:val="restart"/>');
  expect(xml).toContain('<w:vMerge w:val="continue"/>');
  expect(xml).not.toContain('<w:trHeight');
  expect(xml).not.toContain('<w:tblHeader');
  expect(xml).toContain('<w:gridCol w:w="2400"/>');
  expect(xml).toContain('<w:gridCol w:w="3600"/>');
  expect(result.report.blocks).toHaveLength(4);
  expect(result.report.blocks.every((b) => b.outputPartNames.length > 0)).toBe(true);
  expect(result.report.details.every((d) => d.outputPartNames.length > 0)).toBe(true);
  expect(result.plan.report.blocks.every((b) => b.outputPartNames.length === 0)).toBe(true);
  for (const [path, bytes] of Object.entries(result.files)) {
    expect(/vba|oleObject|altChunk|embeddings|attachedTemplate/.test(path)).toBe(false);
    if (/\.xml$|\.rels$/.test(path)) {
      const value = strFromU8(bytes);
      expect(value).not.toContain('PRIVATE_');
      for (const rel of value.matchAll(/<Relationship\b[^>]*TargetMode="External"[^>]*\/>/g)) {
        expect(rel[0]).toContain('/hyperlink"');
        expect(rel[0]).toContain('https://example.com/');
      }
    }
  }
});
it('D03 nested lists use distinct numbering instances and static checkbox states', async () => {
  const c: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'one',
        type: 'numbered-list',
        text: '',
        items: [
          {
            id: 'i1',
            rich: [{ text: 'first' }],
            childLists: [
              {
                id: 'child',
                type: 'bullet_list',
                items: [
                  {
                    id: 'i2',
                    rich: [{ text: 'nested' }],
                    childrenType: 'ordered_list',
                    children: [{ id: 'i3', rich: [{ text: 'third' }] }],
                  },
                ],
              },
            ],
          },
          { id: 'i4', rich: [{ text: 'second' }] },
        ],
      },
      { id: 'two', type: 'numbered-list', text: 'restart at one' },
      {
        id: 'check',
        type: 'check-list',
        text: '',
        items: [
          { id: 'done', checked: true, rich: [{ text: 'complete' }] },
          { id: 'todo', checked: false, rich: [{ text: 'pending' }] },
        ],
      },
    ],
  };
  const r = await encoded(c),
    xml = r.xml();
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
  const first = paragraphs.find((p) => p.includes('>first<'))!,
    second = paragraphs.find((p) => p.includes('>second<'))!,
    restart = paragraphs.find((p) => p.includes('>restart at one<'))!;
  const num = (p: string) => /<w:numId w:val="(\d+)"/.exec(p)![1];
  expect(num(first)).toBe(num(second));
  expect(num(first)).not.toBe(num(restart));
  expect(paragraphs.find((p) => p.includes('>third<'))).toContain('<w:ilvl w:val="2"/>');
  expect(xml).toContain('>[x] </w:t>');
  expect(xml).toContain('>[ ] </w:t>');
  expect(r.report.diagnostics.some((d) => d.code === 'CHECKBOX_STATIC')).toBe(true);
  const numbering = r.xml('word/numbering.xml');
  expect(numbering).toContain('w:val="decimal"');
  expect(numbering).toContain('w:val="bullet"');
  expect(numbering).toContain('<w:start w:val="1"/>');
});
it('D04 horizontal and rectangular merges output anchors once, preserve paragraph priority and explicit headers', async () => {
  const c: DocumentContent = {
    schemaVersion: 1,
    blocks: [
      {
        id: 'table',
        type: 'table',
        text: '',
        cells: [
          ['header', 'hidden', 'third'],
          ['anchor', 'covered1', 'visible'],
          ['covered2', 'covered3', 'end'],
        ],
        merges: [
          { row: 0, col: 0, rows: 1, cols: 2 },
          { row: 1, col: 0, rows: 2, cols: 2 },
        ],
        cellHeaders: [
          [true, true, true],
          [false, false, false],
          [false, false, false],
        ],
        cellParagraphs: [[[], null as never, [{ id: 'p', rich: [{ text: 'priority' }] }]]],
      },
    ],
  };
  const r = await encoded(c);
  const xml = r.xml();
  expect(xml.match(/<w:gridSpan w:val="2"\/>/g)).toHaveLength(3);
  expect(xml.match(/>anchor<\/w:t>/g)).toHaveLength(1);
  for (const text of ['header', 'hidden', 'covered1', 'covered2', 'covered3', 'third'])
    expect(xml).not.toContain(`>${text}<`);
  expect(xml).toContain('>priority</w:t>');
  expect(xml.match(/<w:tblHeader\/>/g)).toHaveLength(1);
});
it.each([
  ['A4', false, 11906, 16838],
  ['A4', true, 16838, 11906],
  ['Letter', false, 12240, 15840],
  ['Letter', true, 15840, 12240],
] as const)(
  'D06 %s landscape=%s retains page dimensions and margins',
  async (size, landscape, width, height) => {
    const c = contractDocument();
    c.page = { size, landscape, margin: 80 };
    const r = await encoded(c);
    expect(r.xml()).toContain(`w:w="${width}" w:h="${height}"`);
    expect(r.xml()).toContain('w:top="1200"');
    expect(r.xml()).toContain('w:left="1200"');
  },
);
it('D07/D08 embedded pictures, escaped source and code use owned bytes and a declared monospace font', async () => {
  const c = contractDocument();
  c.blocks.push(
    {
      id: 'image',
      type: 'image',
      text: '',
      src: 'https://example.com/image.png',
      alt: '日本語の画像',
      caption: '図の説明',
      width: 900,
    },
    {
      id: 'source',
      type: 'react-preview',
      text: '<script>globalThis.attacked=1</script>\n  x\t y',
      language: 'javascript',
    },
  );
  const r = await encoded(
    c,
    { ...contractOptions, previewBlocks: 'source' },
    { resolveAsset: async () => contractPng() },
  );
  expect(r.xml()).toContain('descr="日本語の画像"');
  expect(r.xml()).toContain('図の説明');
  expect(r.xml()).toContain('&lt;script&gt;globalThis.attacked=1&lt;/script&gt;');
  expect(r.xml()).toContain('Noto Sans Mono CJK JP');
  expect(r.report.diagnostics.some((d) => d.code === 'IMAGE_SCALED_TO_BODY')).toBe(true);
  const media = Object.keys(r.files).filter(
    (p) => p.startsWith('word/media/') && p.endsWith('.png'),
  );
  expect(media).toHaveLength(1);
  expect(r.files[media[0]]).toEqual(contractPng().bytes);
  expect(
    (
      await encodeDocumentDocx(r.plan, {
        planHash: r.plan.report.planHash,
        acceptedDiagnosticIds: [],
      })
    ).status,
  ).toBe('blocked');
});

it('D04/D07 keeps adjacent table blocks distinct and gives every drawing a unique identity', async () => {
  const c: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      { id: 'table1', type: 'table', text: '', cells: [['one']] },
      { id: 'table2', type: 'table', text: '', cells: [['two']] },
      ...['image1', 'image2'].map((id) => ({
        id,
        type: 'image' as const,
        text: '',
        src: 'https://example.com/p.png',
      })),
    ],
  };
  const r = await encoded(c, contractOptions, { resolveAsset: async () => contractPng() });
  expect(r.xml()).toMatch(/<\/w:tbl><w:p>[\s\S]*?<\/w:p><w:tbl>/);
  const ids = [...r.xml().matchAll(/<wp:docPr id="([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toEqual(['1', '2']);
  expect(r.report.details.every((d) => d.outputPartNames.length === 1)).toBe(true);
});

it('D03 legacy child lists inherit the checked-list meaning unless explicitly overridden', async () => {
  const c: DocumentContent = {
    schemaVersion: 1,
    blocks: [
      {
        id: 'check',
        type: 'check-list',
        text: '',
        items: [
          {
            id: 'done',
            checked: true,
            rich: [{ text: 'parent' }],
            children: [{ id: 'child', checked: true, rich: [{ text: 'nested done' }] }],
          },
        ],
      },
    ],
  };
  const r = await encoded(c);
  expect(r.xml().match(/>\[x\] <\/w:t>/g)).toHaveLength(2);
  expect(r.xml()).not.toContain('<w:numPr>');
});
it('retains non-one list starts and emits explicit semantic heading/root styles', async () => {
  const result = await encoded({
    schemaVersion: 2,
    blocks: [
      { id: 'heading', type: 'heading', level: 2, text: 'Semantic heading' },
      {
        id: 'list',
        type: 'numbered-list',
        start: 7,
        text: 'parent\nchild',
        items: [
          {
            id: 'parent',
            rich: [{ text: 'parent' }],
            childLists: [
              {
                id: 'nested',
                type: 'ordered_list',
                start: 5,
                items: [{ id: 'child', rich: [{ text: 'child' }] }],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.xml('word/styles.xml')).toContain('w:styleId="Normal"');
  expect(result.xml('word/styles.xml')).toContain('<w:outlineLvl w:val="1"/>');
  const { prepareDocumentImport } = await import('@editor-platform/document-import');
  const { materializeOfficeImport } = await import('@editor-platform/office-import-core');
  const p = await prepareDocumentImport(
    { bytes: result.bytes, format: 'docx' },
    { unsupported: 'review-conversions', fontProfileId: 'noto-cjk-jp-2.004' },
    'numbering-encode',
  );
  const doc = materializeOfficeImport(p, {
    planHash: p.report.planHash,
    acceptedDiagnosticIds: p.report.diagnostics.filter((d) => d.requiresConsent).map((d) => d.id),
  }).draft.content;
  expect(doc.blocks[0]).toMatchObject({ type: 'heading', level: 2 });
  expect(doc.blocks[1]).toMatchObject({ type: 'numbered-list', start: 7 });
  expect(doc.blocks[1].items?.[0].childLists?.[0].start).toBe(5);
});
