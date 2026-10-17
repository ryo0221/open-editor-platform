import { nodePptx } from '../../../tests/fixtures/office/node';
import { makeReviewPptx } from '../../../tests/fixtures/office/import/review';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { exportSlideSvg, type SlideContent } from '@editor-platform/slide/model';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import {
  applyOfficeImport,
  cancelOfficeImport,
  localImportCreationAdapter,
  materializeOfficeImport,
  sourceKey,
  type ImportConsent,
} from '@editor-platform/office-import-core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { prepareSlideImport } from './prepare';
import type { SlideImportOptions, SlideImportPlan } from './types';
const file = new URL('../../../tests/fixtures/office/import/external.pptx', import.meta.url);
const options: SlideImportOptions = {
  unsupported: 'review-conversions',
  fontProfileId: 'noto-cjk-jp-2.004',
  pages: 'all',
  includeHidden: false,
  notes: 'exclude',
  exclude: ['ppt/slides/slide1.xml#/sld[1]/AlternateContent[1]'],
};
const adapters = { version: 'node-image-validator-1', decodeImage: decodeNodeOfficeImage };
const source = async () => ({
  format: 'pptx' as const,
  bytes: new Uint8Array(await readFile(file)),
});
const consent = (p: SlideImportPlan): ImportConsent => ({
  planHash: p.report.planHash,
  acceptedDiagnosticIds: p.report.diagnostics.filter((d) => d.requiresConsent).map((d) => d.id),
});
it('reviews theme effects on shapes and pictures in a derived external PPTX without losing hidden content, colors or breaks', async () => {
  const input = { format: 'pptx' as const, bytes: makeReviewPptx((await source()).bytes) };
  const plan = await prepareSlideImport(
    input,
    { ...options, exclude: [], notes: 'include' },
    'review',
    adapters,
  );
  const blocked = plan.report.diagnostics.filter((d) => d.disposition === 'blocked');
  expect(blocked.map((d) => d.code).sort()).toEqual([
    'SHAPE_EFFECT',
    'UNKNOWN_CAPABILITY',
    'UNSUPPORTED_ELEMENT',
  ]);
  const reviewed = await prepareSlideImport(
    input,
    { ...options, notes: 'include', exclude: blocked.map((d) => sourceKey(d.address)) },
    'review',
    adapters,
  );
  const deck = materializeOfficeImport(reviewed, consent(reviewed)).draft.content;
  expect(deck.slides[0].objects.find((o) => o.type === 'group')?.hidden).toBe(true);
  expect(deck.slides[0].objects.find((o) => o.type === 'table')?.table?.rows[0][0]).toBe(
    '氏名\n部署',
  );
  expect(deck.slides[0].notes).toBe('第一段落\n続き\n\n次の段落');
  const text = deck.slides[0].objects.find((o) => o.text.includes('継承された赤い文字'))!;
  expect(text.runs?.[0].style?.color).toBe('#ff0000');
  expect(text.runs?.[2].style?.color).toBe('#0000ff');
  expect(exportSlideSvg(deck, deck.slides[0])).not.toContain('非表示の');
});
async function mutated(from: string, find: string, replacement: string) {
  const s = await source(),
    files = unzipSync(s.bytes);
  files[from] = strToU8(strFromU8(files[from]).replace(find, replacement));
  return { ...s, bytes: zipSync(files) };
}
describe('independent LibreOffice presentation import', () => {
  it('resolves master content, world groups, text, simple table and owned image', async () => {
    const p = await prepareSlideImport(await source(), options, 'external', adapters);
    expect(p.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
    const a = materializeOfficeImport(p, consent(p)),
      deck = a.draft.content,
      page = deck.slides[0];
    expect(deck.width).toBe(960);
    expect(deck.height).toBe(540);
    expect(page.objects.map((o) => o.text).filter(Boolean)).toEqual([
      '共通の受付案内',
      '外部作成の受付改善資料',
      '受付',
      '確認',
    ]);
    expect(page.objects.filter((o) => o.type === 'group')).toHaveLength(1);
    const group = page.objects.find((o) => o.type === 'group')!;
    const groupChildren = page.objects.filter((o) => o.groupId === group.id);
    expect(groupChildren[0].bounds.x).toBeCloseTo(720000 / 9525, 8);
    expect(groupChildren[1].bounds.x).toBeCloseTo(3060000 / 9525, 8);
    expect(page.objects.find((o) => o.type === 'table')?.table?.rows).toEqual([
      ['項目', '確認'],
      ['受付', '完了'],
    ]);
    expect(page.objects.find((o) => o.type === 'image')?.src).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(a)).not.toContain('PRIVATE_OFFICE_AUTHOR_SENTINEL');
    expect(p.report.mapping.some((m) => m.source.part.includes('slideMaster'))).toBe(true);
    expect(p.report.diagnostics.some((d) => d.code === 'IMAGE_STRETCH')).toBe(false);
    if (process.env.IMPORT_CORPUS_OUTPUT) {
      await mkdir(process.env.IMPORT_CORPUS_OUTPUT, { recursive: true });
      await writeFile(
        `${process.env.IMPORT_CORPUS_OUTPUT}/external-slide.json`,
        JSON.stringify(a, null, 2),
      );
      await writeFile(
        `${process.env.IMPORT_CORPUS_OUTPUT}/external-slide-report.json`,
        JSON.stringify(p.report, null, 2),
      );
      await writeFile(
        `${process.env.IMPORT_CORPUS_OUTPUT}/external-slide.svg`,
        exportSlideSvg(deck, page),
      );
    }
  });
  it('owns source/options before await, freezes preview/report and requires exact current consent', async () => {
    const input = await source(),
      original = input.bytes.slice(),
      o = clone(options),
      pending = prepareSlideImport(input, o, 'ownership', adapters);
    input.bytes.fill(0);
    o.notes = 'include';
    const p = await pending,
      p2 = await prepareSlideImport(
        { format: 'pptx', bytes: original },
        options,
        'ownership',
        adapters,
      );
    expect(p.report.planHash).toBe(p2.report.planHash);
    expect(Object.isFrozen(p.preview.slides[0].objects)).toBe(true);
    expect(() =>
      materializeOfficeImport(p, { planHash: p.report.planHash, acceptedDiagnosticIds: [] }),
    ).toThrow(/Confirm/);
    expect(() => materializeOfficeImport(p, { ...consent(p), planHash: 'stale' })).toThrow(
      /Confirm/,
    );
    expect(() => materializeOfficeImport({ ...p }, consent(p))).toThrow(/owned/);
  });
  it('rejects same-part duplicate IDs, but namespaces repeated IDs on different pages', async () => {
    const input = await mutated('ppt/slides/slide1.xml', 'id="5"', 'id="4"');
    await expect(prepareSlideImport(input, options, 'duplicate', adapters)).rejects.toMatchObject({
      code: 'DUPLICATE_SOURCE_ID',
    });
  });
  it('blocks unknown shapes then removes only the explicitly excluded element', async () => {
    const input = await source();
    // The first text box can retain its text even with unsupported decoration; use the separate blue rectangle.
    const files = unzipSync(input.bytes),
      text = strFromU8(files['ppt/slides/slide1.xml']);
    files['ppt/slides/slide1.xml'] = strToU8(
      text.replace(/(<p:cNvPr id="5"[\s\S]*?<a:prstGeom prst=")rect/, '$1cloud'),
    );
    const changed = { format: 'pptx' as const, bytes: zipSync(files) },
      p = await prepareSlideImport(changed, options, 'unsupported', adapters);
    const blocked = p.report.diagnostics.find((d) => d.code === 'SHAPE_UNSUPPORTED')!;
    expect(blocked).toBeDefined();
    expect(() => materializeOfficeImport(p, consent(p))).toThrow(/blocked/);
    const next = await prepareSlideImport(
      changed,
      { ...options, exclude: [...(options.exclude ?? []), sourceKey(blocked.address)] },
      'unsupported',
      adapters,
    );
    expect(next.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
    expect(next.report.planHash).not.toBe(p.report.planHash);
    expect(
      next.report.diagnostics.some(
        (d) => d.disposition === 'excluded' && d.code === 'SHAPE_UNSUPPORTED',
      ),
    ).toBe(true);
  });
  it('uses atomic create-if-absent, survives lost receipts, checks permission and conflicts', async () => {
    const p = await prepareSlideImport(await source(), options, 'retry', adapters),
      store = new MemoryStorage<Artifact<SlideContent>>();
    let lose = true;
    const local = localImportCreationAdapter(store, () => true),
      host = {
        async createIfAbsent(a: Artifact<SlideContent>) {
          const r = await local.createIfAbsent(a);
          if (lose) {
            lose = false;
            throw Error('lost receipt');
          }
          return r;
        },
      };
    await expect(applyOfficeImport(p, consent(p), host)).rejects.toThrow('lost receipt');
    expect(() => cancelOfficeImport(p)).toThrow(/receipt/);
    const a = await applyOfficeImport(p, consent(p), host);
    expect(await store.list()).toHaveLength(1);
    expect(a.id).toBe('office_retry');
    const changed = await prepareSlideImport(
      await source(),
      { ...options, name: 'Different name' },
      'retry',
      adapters,
    );
    await expect(applyOfficeImport(changed, consent(changed), local)).rejects.toMatchObject({
      code: 'request-conflict',
    });
    await expect(
      applyOfficeImport(
        p,
        consent(p),
        localImportCreationAdapter(store, () => false),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const cancelled = await prepareSlideImport(await source(), options, 'cancelled', adapters);
    cancelOfficeImport(cancelled);
    await expect(applyOfficeImport(cancelled, consent(cancelled), local)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(await store.list()).toHaveLength(1);
  });
});
it('I07 imports the separate self-export corpus as editable native elements with source text order', async () => {
  const native = JSON.parse(
    await readFile('tests/fixtures/office/corpus/pptx/golden.native.json', 'utf8'),
  ) as SlideContent;
  const { bytes } = await nodePptx(
    native,
    { kind: 'saved-version', artifactId: 'self', versionId: 'fixture' },
    {
      pageIds: 'all',
      includeHiddenSlides: true,
      includeNotes: false,
      fontProfileId: 'noto-cjk-jp-2.004',
      fallback: 'element-png',
    },
  );
  const p = await prepareSlideImport(
    { bytes, format: 'pptx' },
    { ...options, exclude: [], includeHidden: true },
    'self-export',
    adapters,
  );
  expect(p.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
  const deck = materializeOfficeImport(p, consent(p)).draft.content;
  expect(deck.slides).toHaveLength(7);
  const archive = unzipSync(bytes);
  const unescape = (s: string) =>
    s
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'");
  deck.slides.forEach((page, index) => {
    const xml = strFromU8(archive[`ppt/slides/slide${index + 1}.xml`]);
    const sourceText = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => unescape(m[1]))
      .join('');
    const nativeText = page.objects
      .map((o) => (o.type === 'table' ? o.table?.rows.flat().join('') : o.text))
      .join('')
      .replaceAll('\n', '');
    expect(nativeText).toBe(sourceText.replaceAll('\n', ''));
  });
  expect(
    new Set(deck.slides[2].objects.filter((o) => o.type === 'shape').map((o) => o.shape)).size,
  ).toBe(13);
}, 60000);
it('inspects the independent upstream Office theme fixture and declares its unsupported decoration', async () => {
  const input = {
    bytes: new Uint8Array(await readFile('tests/fixtures/office/import/upstream/ooxtheme.pptx')),
    format: 'pptx' as const,
  };
  const p = await prepareSlideImport(
    input,
    { ...options, exclude: [] },
    'upstream-theme',
    adapters,
  );
  if (process.env.IMPORT_CORPUS_OUTPUT) {
    await mkdir(process.env.IMPORT_CORPUS_OUTPUT, { recursive: true });
    await writeFile(
      `${process.env.IMPORT_CORPUS_OUTPUT}/upstream-theme-plan.json`,
      JSON.stringify({ report: p.report, preview: p.preview }, null, 2),
    );
  }
  expect(p.preview.slides).toHaveLength(1);
  expect(p.preview.slides[0].objects.some((o) => o.text === 'Theme test')).toBe(true);
  const blocked = p.report.diagnostics.filter((d) => d.disposition === 'blocked');
  expect(blocked).toHaveLength(5);
  expect(
    blocked.every(
      (d) =>
        d.code === 'SHAPE_UNSUPPORTED' && d.address.part === 'ppt/slideLayouts/slideLayout1.xml',
    ),
  ).toBe(true);
  expect(() => materializeOfficeImport(p, consent(p))).toThrow(/blocked/);
  const next = await prepareSlideImport(
    input,
    { ...options, exclude: blocked.map((d) => sourceKey(d.address)) },
    'upstream-theme',
    adapters,
  );
  expect(next.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
  const native = materializeOfficeImport(next, consent(next));
  const title = native.draft.content.slides[0].objects.find((o) => o.text === 'Theme test')!;
  expect(title.bounds.x).toBeCloseTo(1507067 / 9525);
  expect(title.bounds.y).toBeCloseTo(2404534 / 9525);
  expect(title.typography).toMatchObject({
    verticalAlign: 'bottom',
    align: 'right',
    fontSize: 72,
    color: '#90c226',
  });
  expect(native.draft.content.slides[0].objects.filter((o) => o.shape === 'line')).toHaveLength(2);
  expect(
    next.report.diagnostics.some(
      (d) => d.code === 'FONT_SUBSTITUTION' && d.message.includes('Trebuchet MS'),
    ),
  ).toBe(true);
  expect(next.report.diagnostics.some((d) => d.code === 'OFFICE_IDENTITY_EXCLUDED')).toBe(true);
  for (const d of next.report.diagnostics.filter((d) => d.code === 'FONT_SUBSTITUTION'))
    expect(d.address.elementId).toBeUndefined();
  if (process.env.IMPORT_CORPUS_OUTPUT) {
    await writeFile(
      `${process.env.IMPORT_CORPUS_OUTPUT}/upstream-theme-reviewed.json`,
      JSON.stringify({ report: next.report, preview: next.preview }, null, 2),
    );
    await writeFile(
      `${process.env.IMPORT_CORPUS_OUTPUT}/upstream-theme.svg`,
      exportSlideSvg(native.draft.content, native.draft.content.slides[0]),
    );
  }
});
