import { it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  namespaces as ns,
  materializeOfficeImport,
  sourceKey,
} from '@editor-platform/office-import-core';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import {
  exportHtml,
  exportMarkdown,
  isDocument,
  nestedLists,
} from '@editor-platform/document/model';
import { prepareDocumentImport } from './prepare';
const options = {
  unsupported: 'review-conversions' as const,
  fontProfileId: 'noto-cjk-jp-2.004' as const,
};
function input(body: string, parts: Record<string, string> = {}) {
  const files: Record<string, Uint8Array> = {};
  const put = (name: string, value: string) => (files[name] = strToU8(value));
  put(
    '[Content_Types].xml',
    `<Types xmlns="${ns.contentTypes}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  put(
    '_rels/.rels',
    `<Relationships xmlns="${ns.relationships}"><Relationship Id="doc" Type="${ns.rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  put(
    'word/document.xml',
    `<w:document xmlns:w="${ns.w}" xmlns:r="${ns.rel}"><w:body>${body}</w:body></w:document>`,
  );
  put(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="${ns.relationships}">${Object.keys(parts)
      .filter((n) => ['styles', 'numbering', 'theme'].includes(n))
      .map((n) => `<Relationship Id="${n}" Type="${ns.rel}/${n}" Target="${n}.xml"/>`)
      .join('')}</Relationships>`,
  );
  for (const [name, xml] of Object.entries(parts)) put(`word/${name}.xml`, xml);
  return { bytes: zipSync(files), format: 'docx' as const };
}
const p = (text: string, props = '') =>
  `<w:p><w:pPr>${props}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const num = (id: number, level = 0) =>
  `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr>`;
const make = async (s: ReturnType<typeof input>, exclude: string[] = []) =>
  prepareDocumentImport(s, { ...options, ...(exclude.length ? { exclude } : {}) }, 'capabilities');
const native = (plan: Awaited<ReturnType<typeof make>>) =>
  materializeOfficeImport(plan, {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: plan.report.diagnostics
      .filter((d) => d.requiresConsent)
      .map((d) => d.id),
  }).draft.content;
const numbering = `<w:numbering xmlns:w="${ns.w}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="5"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>`;
it('keeps non-one starts, nested restarts, continuation after paragraphs and independent numbering boundaries', async () => {
  const plan = await make(
    input(
      p('first', num(7)) +
        p('child', num(7, 1)) +
        p('next', num(7)) +
        p('restarted child', num(7, 1)) +
        p('outside') +
        p('continued', num(7)) +
        p('independent', num(8)),
      { numbering },
    ),
  );
  expect(plan.report.diagnostics.filter((d) => d.disposition === 'blocked')).toEqual([]);
  const doc = native(plan);
  expect(doc.blocks.map((b) => [b.type, b.start])).toEqual([
    ['numbered-list', 3],
    ['paragraph', undefined],
    ['numbered-list', 5],
    ['numbered-list', undefined],
  ]);
  expect(nestedLists(doc.blocks[0].items![0])[0].start).toBe(5);
  expect(nestedLists(doc.blocks[0].items![1])[0].start).toBe(5);
  const round = nodeToContent(contentToNode(doc), doc);
  expect(round.blocks.filter((b) => b.items)).toEqual(doc.blocks.filter((b) => b.items));
  expect(round.blocks.find((b) => b.type === 'paragraph')).toMatchObject(
    doc.blocks.find((b) => b.type === 'paragraph')!,
  );
  expect(exportHtml(round)).toContain('<ol start="3">');
  expect(exportHtml(round)).toContain('<ol start="5">');
  expect(exportMarkdown(round)).toContain('3. first');
  expect(exportMarkdown(round)).toContain('5. continued');
  expect(isDocument({ ...doc, blocks: [{ ...doc.blocks[0], start: 0 }] })).toBe(false);
  expect(isDocument({ ...doc, blocks: [{ ...doc.blocks[0], start: 1_000_001 }] })).toBe(false);
});
it('resolves inherited outline and partial numPr without relying on style names, and fails style cycles', async () => {
  const styles = `<w:styles xmlns:w="${ns.w}"><w:style w:type="paragraph" w:styleId="A"><w:pPr><w:outlineLvl w:val="2"/><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:basedOn w:val="A"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style></w:styles>`;
  const doc = native(
    await make(
      input(
        p('semantic', '<w:pStyle w:val="A"/>' + num(0)) +
          p('name is irrelevant', '<w:pStyle w:val="Heading1"/>' + num(0)) +
          p(
            'inherited number',
            '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="1"/></w:numPr>',
          ),
        { styles, numbering },
      ),
    ),
  );
  expect(doc.blocks[0]).toMatchObject({
    type: 'heading',
    level: 3,
    rich: [{ text: 'semantic', bold: true }],
  });
  expect(doc.blocks[1].type).toBe('paragraph');
  expect(doc.blocks[2]).toMatchObject({ type: 'numbered-list', start: 5 });
  const cycle = styles.replace(
    '<w:style w:type="paragraph" w:styleId="A">',
    '<w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="Heading1"/>',
  );
  await expect(
    make(input(p('cycle', '<w:pStyle w:val="A"/>'), { styles: cycle, numbering })),
  ).rejects.toMatchObject({ code: 'STYLE_CYCLE' });
});
it('requires explicit exclusions for sections/columns and keeps supported landscape Letter/margins', async () => {
  const s = input(
    p('one', '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>') +
      p('two') +
      '<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="720" w:left="720" w:right="720" w:bottom="720"/><w:cols w:num="2"/></w:sectPr>',
  );
  const a = await make(s),
    blocked = a.report.diagnostics.filter((d) => d.disposition === 'blocked');
  expect(blocked.map((d) => d.code).sort()).toEqual(['MULTIPLE_COLUMNS', 'MULTIPLE_SECTIONS']);
  const b = await make(
    s,
    blocked.map((d) => sourceKey(d.address)),
  );
  expect(native(b).page).toEqual({ size: 'Letter', margin: 48, landscape: true });
  expect(native(b).blocks.map((b) => b.text)).toEqual(['one', 'two']);
});
it('rejects unresolved list references and broken vertical merge rectangles', async () => {
  await expect(make(input(p('bad', num(99)), { numbering }))).rejects.toMatchObject({
    code: 'UNRESOLVED_NUMBERING',
  });
  await expect(
    make(
      input(
        '<w:tbl><w:tblGrid><w:gridCol w:w="150"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>',
      ),
    ),
  ).rejects.toMatchObject({ code: 'TABLE_MERGE' });
});
it('enforces 2,000 source blocks and 50,000 logical table cells at their exact boundaries', async () => {
  expect((await make(input('<w:p/>'.repeat(2000)))).preview.blocks).toHaveLength(2000);
  await expect(make(input('<w:p/>'.repeat(2001)))).rejects.toMatchObject({ code: 'BLOCK_LIMIT' });
  const table = (cols: number) =>
    '<w:tbl><w:tblGrid>' +
    '<w:gridCol w:w="15"/>'.repeat(cols) +
    '</w:tblGrid>' +
    ('<w:tr>' + '<w:tc><w:p/></w:tc>'.repeat(cols) + '</w:tr>').repeat(250) +
    '</w:tbl>';
  const exact = await make(input(table(200)));
  expect(exact.preview.blocks[0].cells).toHaveLength(250);
  expect(exact.preview.blocks[0].cells![0]).toHaveLength(200);
  await expect(make(input(table(201)))).rejects.toMatchObject({ code: 'TABLE_CELL_LIMIT' });
}, 30000);
it('resolves theme system colors and diagnoses unknown used numbering properties', async () => {
  const theme = `<a:theme xmlns:a="${ns.a}"><a:themeElements><a:clrScheme><a:dk1><a:sysClr val="windowText" lastClr="123456"/></a:dk1></a:clrScheme></a:themeElements></a:theme>`;
  const themed = input(
    '<w:p><w:r><w:rPr><w:color w:themeColor="text1"/></w:rPr><w:t>theme</w:t></w:r></w:p>',
    { theme },
  );
  expect(native(await make(themed)).blocks[0].rich?.[0].color).toBe('#123456');
  const s = input(p('item', num(7).replace('</w:numPr>', '<w:unknown/></w:numPr>')), { numbering });
  const first = await make(s),
    blocked = first.report.diagnostics.filter((d) => d.disposition === 'blocked');
  expect(blocked.map((d) => d.code)).toEqual(['NUMBERING_PROPERTY']);
  expect(
    native(
      await make(
        s,
        blocked.map((d) => sourceKey(d.address)),
      ),
    ).blocks[0].start,
  ).toBe(3);
});
