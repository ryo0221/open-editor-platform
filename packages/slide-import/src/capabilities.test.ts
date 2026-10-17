import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { prepareSlideImport } from './prepare';
import { exportSlideSvg, slidePaintOrder } from '@editor-platform/slide/model';
import type { SlideImportOptions } from './types';
import {
  materializeOfficeImport,
  sourceKey,
  namespaces as ns,
} from '@editor-platform/office-import-core';
const options: SlideImportOptions = {
  unsupported: 'review-conversions',
  fontProfileId: 'noto-cjk-jp-2.004',
  pages: 'all',
  includeHidden: false,
  notes: 'exclude',
};
const sp = (id: number, kind = 'rect', extra = '', properties = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="drawing"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="95250" y="190500"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="${kind}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="123456"/></a:solidFill>${properties}</p:spPr>${extra}</p:sp>`;
function pptx(
  trees: string[],
  extras: Record<string, string> = {},
  pageAttrs: Record<number, string> = {},
) {
  const files: Record<string, Uint8Array> = {};
  const add = (name: string, s: string) => (files[name] = strToU8(s));
  add(
    '[Content_Types].xml',
    `<Types xmlns="${ns.contentTypes}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
  );
  add(
    '_rels/.rels',
    `<Relationships xmlns="${ns.relationships}"><Relationship Id="doc" Type="${ns.rel}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );
  add(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="${ns.p}" xmlns:r="${ns.rel}"><p:sldIdLst>${trees.map((_, i) => `<p:sldId id="${256 + i}" r:id="p${i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
  );
  add(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships xmlns="${ns.relationships}">${trees.map((_, i) => `<Relationship Id="p${i}" Type="${ns.rel}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
  );
  trees.forEach((tree, i) =>
    add(
      `ppt/slides/slide${i + 1}.xml`,
      `<p:sld xmlns:p="${ns.p}" xmlns:a="${ns.a}" xmlns:r="${ns.rel}" ${pageAttrs[i] ?? ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="0" name=""/></p:nvGrpSpPr>${tree}</p:spTree></p:cSld></p:sld>`,
    ),
  );
  for (const [k, v] of Object.entries(extras)) add(k, v);
  return { bytes: zipSync(files), format: 'pptx' as const };
}
const prepared = (input: ReturnType<typeof pptx>, o: SlideImportOptions = options) =>
  prepareSlideImport(input, o, 'capabilities');
const create = (p: Awaited<ReturnType<typeof prepared>>) =>
  materializeOfficeImport(p, {
    planHash: p.report.planHash,
    acceptedDiagnosticIds: p.report.diagnostics.filter((d) => d.requiresConsent).map((d) => d.id),
  });
const textBody = (paragraphs: string) =>
  `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>`;
const run = (text: string, properties = '') =>
  `<a:r>${properties ? `<a:rPr>${properties}</a:rPr>` : ''}<a:t>${text}</a:t></a:r>`;
const themeParts = (effects = ''): Record<string, string> => {
  const rel = (type: string, target: string) =>
    `<Relationships xmlns="${ns.relationships}"><Relationship Id="ref" Type="${ns.rel}/${type}" Target="${target}"/></Relationships>`;
  const declaration = `xmlns:p="${ns.p}" xmlns:a="${ns.a}"`;
  return {
    'ppt/slides/_rels/slide1.xml.rels': rel('slideLayout', '../slideLayouts/slideLayout1.xml'),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${declaration}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rel(
      'slideMaster',
      '../slideMasters/slideMaster1.xml',
    ),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${declaration}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rel('theme', '../theme/theme1.xml'),
    'ppt/theme/theme1.xml': `<a:theme xmlns:a="${ns.a}"><a:themeElements><a:clrScheme name="review"><a:accent1><a:srgbClr val="ff0000"/></a:accent1></a:clrScheme><a:fmtScheme name="review"><a:effectStyleLst>${effects}</a:effectStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  };
};
describe('Issue #14 review regressions', () => {
  it('keeps hidden groups editable while hiding their children in preview and SVG', async () => {
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="hidden group" hidden="1"/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/><a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/></a:xfrm></p:grpSpPr>${sp(1, 'rect', textBody(`<a:p>${run('Hidden child')}</a:p>`))}</p:grpSp>`;
    const p = await prepared(pptx([group]));
    const deck = create(p).draft.content,
      page = deck.slides[0];
    expect(page.objects.find((o) => o.type === 'group')?.hidden).toBe(true);
    expect(page.objects.find((o) => o.text === 'Hidden child')?.hidden).toBeUndefined();
    expect(slidePaintOrder(page).find((o) => o.text === 'Hidden child')?.hidden).toBe(true);
    expect(exportSlideSvg(deck, page)).not.toContain('Hidden');
    const shown = {
      ...page,
      objects: page.objects.map((o) => (o.type === 'group' ? { ...o, hidden: false } : o)),
    };
    expect(exportSlideSvg(deck, shown)).toContain('Hidden');
  });
  it('resolves fontRef color before paragraph defaults and individual run formatting', async () => {
    const body = textBody(
      `<a:p>${run('Inherited red')}${run('Explicit blue', '<a:solidFill><a:srgbClr val="0000ff"/></a:solidFill>')}</a:p><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="00ff00"/></a:solidFill></a:defRPr></a:pPr>${run('Paragraph green')}</a:p>`,
    );
    const p = await prepared(
      pptx(
        [
          sp(
            1,
            'rect',
            `<p:style><a:fontRef idx="minor"><a:schemeClr val="accent1"/></a:fontRef></p:style>${body}`,
          ),
        ],
        themeParts(),
      ),
    );
    const object = create(p).draft.content.slides[0].objects[0];
    expect(object.typography?.color).toBe('#ff0000');
    expect(object.runs?.filter((r) => r.text !== '\n').map((r) => r.style?.color)).toEqual([
      '#ff0000',
      '#0000ff',
      '#00ff00',
    ]);
    expect(exportSlideSvg(create(p).draft.content, create(p).draft.content.slides[0])).toContain(
      '#ff0000',
    );
  });
  it('blocks referenced theme shadows until their loss is explicitly excluded and consented', async () => {
    const input = pptx(
      [
        sp(
          1,
          'rect',
          '<p:style><a:effectRef idx="1"><a:srgbClr val="000000"/></a:effectRef></p:style>',
        ),
      ],
      themeParts(
        '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst></a:effectStyle>',
      ),
    );
    const p = await prepared(input),
      blocked = p.report.diagnostics.filter((d) => d.disposition === 'blocked');
    expect(
      blocked.some((d) => d.code === 'SHAPE_EFFECT' && d.address.part === 'ppt/theme/theme1.xml'),
    ).toBe(true);
    expect(() => create(p)).toThrow(/blocked/);
    const reviewed = await prepared(input, {
      ...options,
      exclude: blocked.map((d) => sourceKey(d.address)),
    });
    expect(
      reviewed.report.diagnostics.some(
        (d) => d.code === 'SHAPE_EFFECT' && d.disposition === 'excluded' && d.requiresConsent,
      ),
    ).toBe(true);
    expect(() =>
      materializeOfficeImport(reviewed, {
        planHash: reviewed.report.planHash,
        acceptedDiagnosticIds: [],
      }),
    ).toThrow(/Confirm/);
    expect(create(reviewed).draft.content.slides[0].objects).toHaveLength(1);
  });
  it('preserves table cell line breaks, paragraphs, empty lines and displayed fields', async () => {
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="1" name="table"/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1905000"/></a:tblGrid><a:tr h="952500"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run('氏名')}<a:br/>${run('部署')}</a:p><a:p/><a:p><a:fld id="field" type="slidenum"><a:t>1</a:t></a:fld></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const p = await prepared(pptx([table]));
    expect(create(p).draft.content.slides[0].objects[0].table?.rows).toEqual([['氏名\n部署\n\n1']]);
  });
  it('preserves note paragraph boundaries, explicit breaks and empty paragraphs', async () => {
    const notes = `<p:notes xmlns:p="${ns.p}" xmlns:a="${ns.a}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="notes"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>${textBody(`<a:p>${run('第一段落')}<a:br/>${run('続き')}</a:p><a:p/><a:p>${run('次の段落')}</a:p>`)}</p:sp></p:spTree></p:cSld></p:notes>`;
    const input = pptx([sp(1)], {
      'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${ns.relationships}"><Relationship Id="notes" Type="${ns.rel}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
      'ppt/notesSlides/notesSlide1.xml': notes,
    });
    expect(
      create(await prepared(input, { ...options, notes: 'include' })).draft.content.slides[0].notes,
    ).toBe('第一段落\n続き\n\n次の段落');
    expect(create(await prepared(input)).draft.content.slides[0].notes).toBeUndefined();
  });
  it('inherits fontRef through a placeholder without losing an independent local style reference', async () => {
    const parts = themeParts();
    const ph = '<p:nvPr><p:ph type="title" idx="4"/></p:nvPr>';
    parts['ppt/slideLayouts/slideLayout1.xml'] = parts['ppt/slideLayouts/slideLayout1.xml'].replace(
      '<p:spTree/>',
      `<p:spTree>${sp(1, 'rect', '<p:style><a:fontRef idx="minor"><a:schemeClr val="accent1"/></a:fontRef></p:style>').replace('<p:nvPr/>', ph)}</p:spTree>`,
    );
    const input = pptx(
      [
        sp(
          1,
          'rect',
          `<p:style><a:effectRef idx="0"/></p:style>${textBody(`<a:p>${run('Inherited')}</a:p>`)}`,
        ).replace('<p:nvPr/>', ph),
      ],
      parts,
    );
    expect(
      create(await prepared(input)).draft.content.slides[0].objects[0].runs?.[0].style?.color,
    ).toBe('#ff0000');
  });
  it.each([
    ['no reference', '', ''],
    ['index zero', '<p:style><a:effectRef idx="0"/></p:style>', ''],
    ['selected empty style', '<p:style><a:effectRef idx="2"/></p:style>', ''],
    ['explicit empty override', '<p:style><a:effectRef idx="1"/></p:style>', '<a:effectLst/>'],
  ])('does not diagnose unused theme shadows: %s', async (_, style, props) => {
    const p = await prepared(
      pptx(
        [sp(1, 'rect', style, props)],
        themeParts(
          '<a:effectStyle><a:effectLst><a:outerShdw/></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>',
        ),
      ),
    );
    expect(p.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
    expect(create(p).draft.content.slides[0].objects).toHaveLength(1);
  });
  it.each(['3', '-1', '1.5'])('rejects an unresolved theme effect index %s', async (index) => {
    await expect(
      prepared(
        pptx(
          [sp(1, 'rect', `<p:style><a:effectRef idx="${index}"/></p:style>`)],
          themeParts('<a:effectStyle><a:effectLst/></a:effectStyle>'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_STYLE' });
  });
});
describe('declared PresentationML capabilities', () => {
  it('maps all 13 native basic shapes and preserves rotations and arrow ends', async () => {
    const preset = [
      'rect',
      'roundRect',
      'ellipse',
      'triangle',
      'diamond',
      'line',
      'line',
      'line',
      'rightArrow',
      'leftArrow',
      'upArrow',
      'downArrow',
      'leftRightArrow',
    ];
    const p = await prepared(
      pptx([
        preset
          .map((kind, i) =>
            sp(
              i + 1,
              kind,
              '',
              i === 6
                ? '<a:ln w="9525"><a:tailEnd type="triangle"/></a:ln>'
                : i === 7
                  ? '<a:ln w="9525"><a:headEnd type="triangle"/><a:tailEnd type="triangle"/></a:ln>'
                  : '',
            ),
          )
          .join(''),
      ]),
    );
    expect(p.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
    const line = create(p).draft.content.slides[0].objects[5];
    expect(line.bounds.width).toBeCloseTo(Math.hypot(100, 50));
    expect(line.rotation).toBeCloseTo((Math.atan2(50, 100) * 180) / Math.PI);
    expect(create(p).draft.content.slides[0].objects.map((o) => o.shape)).toEqual([
      'rectangle',
      'rounded-rectangle',
      'ellipse',
      'triangle',
      'diamond',
      'line',
      'arrow',
      'double-arrow',
      'arrow-right',
      'arrow-left',
      'arrow-up',
      'arrow-down',
      'arrow-both',
    ]);
  });
  it('keeps source IDs scoped by part and selects pages/hidden slides explicitly', async () => {
    const input = pptx([sp(1), sp(1), sp(1)], {}, { 1: 'show="0"' });
    const p = await prepared(input);
    expect(p.preview.slides).toHaveLength(2);
    expect(p.report.diagnostics.some((d) => d.code === 'SLIDE_EXCLUDED')).toBe(true);
    const all = await prepared(input, { ...options, includeHidden: true });
    const ids = all.preview.slides.flatMap((s) => s.objects.map((o) => o.id));
    expect(new Set(ids).size).toBe(3);
    expect(all.preview.slides[1].hidden).toBe(true);
    const selected = await prepared(input, { ...options, pages: [3, 1] });
    expect(selected.preview.slides.map((s) => s.title)).toEqual(['Slide 1', 'Slide 3']);
  });
  it('detects unknown namespaces and graphic frames without blank fallback', async () => {
    const shape = sp(1, 'cloud');
    const unknown = '<new:diagram xmlns:new="urn:unknown"/>';
    const graphic =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="chart"/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>';
    const input = pptx([shape + unknown + graphic]),
      p = await prepared(input);
    expect(p.preview.slides[0].objects).toHaveLength(0);
    expect(
      p.report.diagnostics.filter((d) => d.disposition === 'blocked').map((d) => d.code),
    ).toEqual(['SHAPE_UNSUPPORTED', 'DRAWING_UNSUPPORTED', 'GRAPHIC_UNSUPPORTED']);
    const exclude = p.report.diagnostics
        .filter((d) => d.excludable)
        .map((d) => sourceKey(d.address)),
      next = await prepared(input, { ...options, exclude });
    expect(() => create(next)).not.toThrow();
    expect(next.preview.slides[0].objects).toHaveLength(0);
  });
  it('enforces exact page and object limits', async () => {
    expect(
      (await prepared(pptx(Array.from({ length: 100 }, () => sp(1))))).preview.slides,
    ).toHaveLength(100);
    await expect(prepared(pptx(Array.from({ length: 101 }, () => sp(1))))).rejects.toMatchObject({
      code: 'SLIDE_LIMIT',
    });
    expect(
      (await prepared(pptx([Array.from({ length: 10000 }, (_, i) => sp(i + 1)).join('')]))).preview
        .slides[0].objects,
    ).toHaveLength(10000);
    await expect(
      prepared(pptx([Array.from({ length: 10001 }, (_, i) => sp(i + 1)).join('')])),
    ).rejects.toMatchObject({ code: 'OBJECT_LIMIT' });
  }, 30000);
  it('flattens translated/scaled/rotated nested groups exactly once, blocking skew', async () => {
    const group = (xfrm: string, body: string) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="group"/></p:nvGrpSpPr><p:grpSpPr>${xfrm}</p:grpSpPr>${body}</p:grpSp>`;
    const xf =
      '<a:xfrm rot="5400000"><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1905000"/><a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/></a:xfrm>';
    const p = await prepared(pptx([group(xf, sp(1))]));
    const o = p.preview.slides[0].objects.find((o) => o.type === 'shape')!;
    expect(o.rotation).toBeCloseTo(90);
    expect(o.bounds.x).toBeCloseTo(110);
    expect(o.bounds.y).toBeCloseTo(170);
    expect(o.bounds.width).toBeCloseTo(200);
    expect(o.bounds.height).toBeCloseTo(100);
    const skew = group(
      xf.replace('cy="1905000"', 'cy="952500"'),
      sp(1).replace('<a:xfrm>', '<a:xfrm rot="2700000">'),
    );
    expect(
      (await prepared(pptx([skew]))).report.diagnostics.some((d) => d.code === 'SKEWED_GROUP'),
    ).toBe(true);
  });
});
it('resolves placeholder geometry/fill/text style through layout and theme without guessing names', async () => {
  const placeholder = (id: number, properties: string, body: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="title" idx="4"/></p:nvPr></p:nvSpPr><p:spPr>${properties}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
  const declaration = `xmlns:p="${ns.p}" xmlns:a="${ns.a}" xmlns:r="${ns.rel}"`;
  const layout = `<p:sldLayout ${declaration}><p:cSld><p:spTree>${placeholder(1, '<a:xfrm><a:off x="952500" y="476250"/><a:ext cx="3810000" cy="952500"/></a:xfrm><a:solidFill><a:schemeClr val="accent1"/></a:solidFill>', '<a:p><a:pPr><a:defRPr sz="3000" b="1"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:defRPr></a:pPr></a:p>')}</p:spTree></p:cSld></p:sldLayout>`;
  const rel = (type: string, target: string) =>
    `<Relationships xmlns="${ns.relationships}"><Relationship Id="ref" Type="${ns.rel}/${type}" Target="${target}"/></Relationships>`;
  const input = pptx([placeholder(1, '', '<a:p><a:r><a:t>実際の見出し</a:t></a:r></a:p>')], {
    'ppt/slides/_rels/slide1.xml.rels': rel('slideLayout', '../slideLayouts/slideLayout1.xml'),
    'ppt/slideLayouts/slideLayout1.xml': layout,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rel(
      'slideMaster',
      '../slideMasters/slideMaster1.xml',
    ),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${declaration}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rel('theme', '../theme/theme1.xml'),
    'ppt/theme/theme1.xml': `<a:theme xmlns:a="${ns.a}"><a:themeElements><a:clrScheme name="test"><a:accent1><a:srgbClr val="112233"/></a:accent1><a:accent2><a:srgbClr val="ddeeff"/></a:accent2></a:clrScheme></a:themeElements></a:theme>`,
  });
  const p = await prepared(input);
  expect(p.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
  const o = create(p).draft.content.slides[0].objects[0];
  expect(o.bounds).toEqual({ x: 100, y: 50, width: 400, height: 100 });
  expect(o.fill).toBe('#112233');
  expect(o.runs?.[0].style).toMatchObject({ bold: true, fontSize: 40, color: '#ddeeff' });
});
it('notes and external images follow explicit scope without network access', async () => {
  const rels = `<Relationships xmlns="${ns.relationships}"><Relationship Id="notes" Type="${ns.rel}/notesSlide" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="image" Type="${ns.rel}/image" Target="https://example.invalid/private.png" TargetMode="External"/></Relationships>`;
  const notes = `<p:notes xmlns:p="${ns.p}" xmlns:a="${ns.a}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="notes"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>選択した時だけのノート</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  const image =
    '<p:pic><p:nvPicPr><p:cNvPr id="2" name="image"/></p:nvPicPr><p:blipFill><a:blip r:link="image"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr></p:pic>';
  const input = pptx([sp(1) + image], {
    'ppt/slides/_rels/slide1.xml.rels': rels,
    'ppt/notesSlides/notesSlide1.xml': notes,
  });
  const p = await prepared(input);
  expect(p.preview.slides[0].notes).toBeUndefined();
  expect(p.report.diagnostics.some((d) => d.code === 'NOTES_EXCLUDED')).toBe(true);
  const external = p.report.diagnostics.find((d) => d.code === 'EXTERNAL_IMAGE')!;
  expect(external.disposition).toBe('blocked');
  const next = await prepared(input, {
    ...options,
    notes: 'include',
    exclude: [sourceKey(external.address)],
  });
  expect(create(next).draft.content.slides[0].notes).toBe('選択した時だけのノート');
  expect(next.preview.slides[0].objects).toHaveLength(1);
});
