import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { isDocument, nestedLists, type DocumentContent } from '@editor-platform/document/model';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import {
  materializeOfficeImport,
  applyOfficeImport,
  localImportCreationAdapter,
  sourceKey,
  type ImportConsent,
} from '@editor-platform/office-import-core';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { prepareDocumentImport } from './prepare';
import type { DocumentImportOptions, DocumentImportPlan } from './types';
const options: DocumentImportOptions = {
  unsupported: 'review-conversions',
  fontProfileId: 'noto-cjk-jp-2.004',
};
const adapters = { version: 'office-image-validator-1', decodeImage: decodeNodeOfficeImage };
const source = async () => ({
  bytes: new Uint8Array(await readFile('tests/fixtures/office/import/document/external.docx')),
  format: 'docx' as const,
});
const consent = (p: DocumentImportPlan): ImportConsent => ({
  planHash: p.report.planHash,
  acceptedDiagnosticIds: p.report.diagnostics.filter((d) => d.requiresConsent).map((d) => d.id),
});
async function mutate(part: string, change: (xml: string) => string) {
  const s = await source(),
    files = unzipSync(s.bytes);
  files[part] = strToU8(change(strFromU8(files[part])));
  return { ...s, bytes: zipSync(files) };
}
async function evidence(name: string, p: DocumentImportPlan) {
  if (process.env.IMPORT_CORPUS_OUTPUT) {
    await mkdir(process.env.IMPORT_CORPUS_OUTPUT, { recursive: true });
    await writeFile(
      `${process.env.IMPORT_CORPUS_OUTPUT}/${name}.json`,
      JSON.stringify({ report: p.report, preview: p.preview }, null, 2),
    );
  }
}
describe('independent Word document import', () => {
  it('resolves semantic styles, rich/link, nested numbering, rectangular merges and cell paragraphs', async () => {
    const p = await prepareDocumentImport(await source(), options, 'external-word', adapters);
    await evidence('external-word', p);
    expect(p.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
    const doc = materializeOfficeImport(p, consent(p)).draft.content;
    expect(isDocument(doc)).toBe(true);
    expect(doc.blocks[0]).toMatchObject({
      type: 'heading',
      level: 1,
      text: '外部作成の受付改善提案書',
    });
    expect(doc.blocks[1]).toMatchObject({
      type: 'paragraph',
      text: '独自スタイルを継承した見出し',
    });
    expect(doc.blocks[2].rich?.find((s) => s.text === '公式資料')?.link).toBe(
      'https://example.com/guide',
    );
    const list = doc.blocks.find((b) => b.type === 'numbered-list')!;
    expect(list.items?.map((i) => i.rich.map((s) => s.text).join(''))).toEqual([
      '確認する項目',
      '次の項目',
    ]);
    expect(
      nestedLists(list.items![0])[0]
        .items[0].rich.map((s) => s.text)
        .join(''),
    ).toBe('入れ子の確認');
    expect(doc.blocks.find((b) => b.start === 7)?.items?.[0].rich).toEqual([
      expect.objectContaining({ text: '番号を再開した項目' }),
    ]);
    const table = doc.blocks.find((b) => b.type === 'table')!;
    expect(table.merges).toEqual([
      { row: 0, col: 0, rows: 1, cols: 2 },
      { row: 1, col: 0, rows: 2, cols: 1 },
    ]);
    expect(table.cellParagraphs?.[1][0].map((p) => p.rich.map((s) => s.text).join(''))).toEqual([
      '複数段落のセル',
      '次の段落',
    ]);
    expect(doc.blocks.find((b) => b.type === 'image')).toMatchObject({
      alt: '四分割の検証画像',
      width: 2160270 / 9525,
    });
    expect(JSON.stringify(doc)).not.toContain('PRIVATE_OFFICE_AUTHOR_SENTINEL');
    const restored = nodeToContent(contentToNode(doc), doc);
    expect(restored.blocks.map((b) => b.text)).toEqual(doc.blocks.map((b) => b.text));
    expect(restored.blocks.find((b) => b.type === 'table')?.merges).toEqual(table.merges);
  });
  it('owns source and options, invalidates consent, retries atomic creation and rejects stale fingerprints', async () => {
    const s = await source(),
      original = s.bytes.slice(),
      opts = clone(options),
      pending = prepareDocumentImport(s, opts, 'ownership', adapters);
    s.bytes.fill(0);
    opts.name = 'changed';
    const p = await pending,
      p2 = await prepareDocumentImport(
        { format: 'docx', bytes: original },
        options,
        'ownership',
        adapters,
      );
    expect(p.report.planHash).toBe(p2.report.planHash);
    expect(Object.isFrozen(p.preview.blocks)).toBe(true);
    expect(() =>
      materializeOfficeImport(p, { planHash: 'stale', acceptedDiagnosticIds: [] }),
    ).toThrow(/Confirm/);
    const storage = new MemoryStorage<Artifact<DocumentContent>>(),
      local = localImportCreationAdapter(storage, () => true);
    let lose = true;
    const host = {
      async createIfAbsent(a: Artifact<DocumentContent>) {
        const stored = await local.createIfAbsent(a);
        if (lose) {
          lose = false;
          throw Error('lost receipt');
        }
        return stored;
      },
    };
    await expect(applyOfficeImport(p, consent(p), host)).rejects.toThrow('lost receipt');
    await applyOfficeImport(p, consent(p), host);
    expect(await storage.list()).toHaveLength(1);
    const different = await prepareDocumentImport(
      { format: 'docx', bytes: original },
      { ...options, name: 'different' },
      'ownership',
      adapters,
    );
    await expect(applyOfficeImport(different, consent(different), local)).rejects.toMatchObject({
      code: 'request-conflict',
    });
  });
  it('blocks unresolved tracked changes even if review/exclusion is requested', async () => {
    const s = await mutate('word/document.xml', (x) =>
      x.replace('<w:r>', '<w:r><w:delText>unconfirmed</w:delText>'),
    );
    await expect(prepareDocumentImport(s, options, 'revision', adapters)).rejects.toMatchObject({
      code: 'TRACKED_CHANGES',
    });
  });
  it('blocks unknown content and removes only the selected unsupported feature', async () => {
    const s = await mutate('word/document.xml', (x) =>
      x
        .replace(
          '</w:body>',
          '<w:mystery xmlns:q="urn:unknown"><q:secret>hidden</q:secret></w:mystery></w:body>',
        )
        .replace(/(<w:sectPr[\s\S]*?<\/w:sectPr>)([\s\S]*?)(<\/w:body>)/, '$2$1$3'),
    );
    const p = await prepareDocumentImport(s, options, 'unknown', adapters);
    const d = p.report.diagnostics.find((d) => d.code === 'BODY_ELEMENT')!;
    expect(d.disposition).toBe('blocked');
    const next = await prepareDocumentImport(
      s,
      { ...options, exclude: [sourceKey(d.address)] },
      'unknown',
      adapters,
    );
    expect(next.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
    expect(JSON.stringify(next.preview)).not.toContain('hidden');
    expect(next.report.planHash).not.toBe(p.report.planHash);
  });
});
it('records the independent upstream numbering source and its actual capabilities', async () => {
  const bytes = new Uint8Array(
    await readFile('tests/fixtures/office/import/document/numbering1.docx'),
  );
  const p = await prepareDocumentImport(
    { bytes, format: 'docx' },
    options,
    'upstream-numbering',
    adapters,
  );
  await evidence('upstream-numbering', p);
  const original = bytes.slice(),
    blocked = p.report.diagnostics.filter((d) => d.disposition === 'blocked');
  expect(blocked.map((d) => d.code)).toEqual(['NUMBER_LABEL', 'NUMBER_LABEL']);
  expect(() => materializeOfficeImport(p, consent(p))).toThrow();
  const accepted = await prepareDocumentImport(
    { bytes, format: 'docx' },
    { ...options, exclude: blocked.map((d) => sourceKey(d.address)) },
    'upstream-numbering',
    adapters,
  );
  const doc = materializeOfficeImport(accepted, consent(accepted)).draft.content;
  expect(doc.blocks).toHaveLength(1);
  expect(doc.blocks[0].items).toHaveLength(2);
  expect(nestedLists(doc.blocks[0].items![0])[0].items).toHaveLength(2);
  const lastBranch = nestedLists(doc.blocks[0].items![1])[0].items;
  expect(lastBranch).toHaveLength(2);
  expect(nestedLists(lastBranch[1])[0].items).toHaveLength(1);
  const sourceText = [
    ...strFromU8(unzipSync(bytes)['word/document.xml']).matchAll(
      /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g,
    ),
  ]
    .map((m) => m[1])
    .join('');
  expect(doc.blocks[0].text.replaceAll('\n', '')).toBe(sourceText);
  expect(bytes).toEqual(original);
});
it('I07 maps the independent self-export corpus to editable native Word structure with text order', async () => {
  const { nodeDocx } = await import('../../../tests/fixtures/office/docx-node');
  const nativeSource = JSON.parse(
    await readFile('tests/fixtures/office/corpus/docx/golden.native.json', 'utf8'),
  ) as DocumentContent;
  const result = await nodeDocx(nativeSource, {
    kind: 'saved-version',
    artifactId: 'self',
    versionId: 'golden',
  });
  const p = await prepareDocumentImport(
    { bytes: result.bytes, format: 'docx' },
    options,
    'self-word',
    adapters,
  );
  await evidence('self-word', p);
  expect(p.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
  const imported = materializeOfficeImport(p, consent(p)).draft.content;
  expect(imported.blocks.some((b) => b.type === 'heading')).toBe(true);
  expect(imported.blocks.some((b) => b.type === 'table' && b.merges?.length)).toBe(true);
  const sourceXml = strFromU8(unzipSync(result.bytes)['word/document.xml']);
  const sourceText = [...sourceXml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) =>
      m[1]
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'"),
    )
    .join('');
  const target = imported.blocks
    .map((b) => (b.cells ? b.cells.flat().join('') : b.text))
    .join('')
    .replaceAll('\n', '')
    .replaceAll('\t', '');
  expect(target).toBe(sourceText.replaceAll('\n', '').replaceAll('\t', ''));
}, 180000);
