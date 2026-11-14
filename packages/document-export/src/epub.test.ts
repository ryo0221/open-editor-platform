import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import {
  canonicalJson,
  createArtifact,
  commitVersion,
  clone,
} from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document/model';
import {
  prepareDocumentEpub,
  encodeDocumentEpub,
  type DocumentEpubMetadata,
  type DocumentEpubPlan,
} from '@editor-platform/document-export/epub';
const metadata: DocumentEpubMetadata = {
  title: '三章の物語 < & >',
  language: 'ja',
  identifier: 'urn:uuid:09c104c5-1214-49ad-8110-b07b54247802',
  creators: ['Fixture Author'],
  modified: '2026-10-26T00:00:00Z',
};
async function chapters() {
  return Promise.all(
    [1, 2, 3].map(async (n) => {
      const content: DocumentContent = {
        schemaVersion: 2,
        page: { size: 'A4', margin: 64 },
        blocks: [
          { id: 'title', type: 'heading', level: 1, text: `第${n}章` },
          {
            id: 'scene',
            type: 'paragraph',
            text: '日本語\n本文 < & >',
            rich: [
              { text: '日本語', bold: true },
              { text: '\n本文 < & >', italic: true },
            ],
            style: { color: '#112233', fontSize: 12 },
            align: 'justify',
          },
          { id: 'hidden', type: 'paragraph', text: 'Hidden manuscript', hidden: true },
        ],
      };
      const artifact = clone(
        await commitVersion(createArtifact('document', `第${n}章`, content), null, 'fixture'),
      );
      return { artifact, versionId: artifact.versions[0].versionId };
    }),
  );
}
const consent = (plan: DocumentEpubPlan) => ({
  planHash: plan.report.planHash,
  acceptedDiagnosticIds: plan.report.diagnostics
    .filter((d) => d.requiresAcceptance)
    .map((d) => d.id),
});
it('encodes exact three-chapter order as an EPUB3 with owned source/report, valid mimetype and safe XHTML', async () => {
  const sources = (await chapters()).reverse();
  const before = canonicalJson(sources);
  const plan = await prepareDocumentEpub(sources, metadata);
  expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  expect(result.mime).toBe('application/epub+zip');
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(8, true)).toBe(0);
  expect(view.getUint16(28, true)).toBe(0);
  expect(strFromU8(result.bytes.slice(30, 38))).toBe('mimetype');
  const files = unzipSync(result.bytes);
  const read = (p: string) => strFromU8(files[p]);
  expect(read('mimetype')).toBe('application/epub+zip');
  expect(read('EPUB/chapter-001.xhtml')).toContain('第3章');
  expect(read('EPUB/chapter-003.xhtml')).toContain('第1章');
  expect(read('EPUB/chapter-001.xhtml')).toContain('<strong>日本語</strong>');
  expect(read('EPUB/chapter-001.xhtml')).toContain(
    'color:#112233;font-size:12pt;text-align:justify;',
  );
  expect(read('EPUB/chapter-001.xhtml')).toContain('&lt; &amp; &gt;');
  expect(read('EPUB/chapter-001.xhtml')).not.toContain('Hidden manuscript');
  expect(JSON.parse(read('EPUB/sources.json'))).toEqual(plan.report.sources);
  expect(JSON.parse(read('EPUB/export-report.json'))).toEqual(plan.report);
  expect(plan.report.chapters[0].elements[1]).toMatchObject({
    sourceId: 'scene',
    xhtmlId: 'block-2',
  });
  expect(canonicalJson(sources)).toBe(before);
  const again = await encodeDocumentEpub(plan, consent(plan));
  expect(again.status).toBe('ok');
  if (again.status === 'ok') expect(again.bytes).toEqual(result.bytes);
  await mkdir('/tmp/epub-validation', { recursive: true });
  await writeFile('/tmp/epub-validation/fixture.epub', result.bytes);
});
it('captures source and metadata before awaits, and cannot waive warnings/errors or forge plans', async () => {
  const sources = await chapters();
  const options = clone(metadata);
  const pending = prepareDocumentEpub(sources, options);
  options.title = 'Mutated later';
  sources[0].artifact.versions[0].content.blocks[0].text = 'Mutated later';
  const plan = await pending;
  expect(plan.report.metadata.title).toBe(metadata.title);
  expect(
    (await encodeDocumentEpub(plan, { planHash: plan.report.planHash, acceptedDiagnosticIds: [] }))
      .status,
  ).toBe('blocked');
  expect((await encodeDocumentEpub(plan, { ...consent(plan), planHash: 'wrong' })).status).toBe(
    'blocked',
  );
  expect(
    (
      await encodeDocumentEpub(plan, {
        ...consent(plan),
        acceptedDiagnosticIds: [...consent(plan).acceptedDiagnosticIds, 'unknown'],
      })
    ).status,
  ).toBe('blocked');
  expect(
    (await encodeDocumentEpub({ report: plan.report } as DocumentEpubPlan, consent(plan))).status,
  ).toBe('failed');
  const bad = await prepareDocumentEpub(await chapters(), {
    ...metadata,
    writingMode: 'vertical-rl',
  } as DocumentEpubMetadata);
  expect(bad.report.diagnostics.some((d) => d.code === 'INVALID_METADATA')).toBe(true);
  expect((await encodeDocumentEpub(bad, consent(bad))).status).toBe('blocked');
});
it('rejects unsupported links/blocks, invalid XML, corrupt or missing exact versions without partial bytes', async () => {
  for (const change of [
    (d: DocumentContent) => {
      d.blocks[1].rich![0].link = 'javascript:alert(1)';
    },
    (d: DocumentContent) => {
      d.blocks[1].rich![0].text = '\u0000';
    },
    (d: DocumentContent) => {
      d.blocks[1].type = 'html';
    },
  ]) {
    const sources = await chapters();
    const content = clone(sources[0].artifact.draft.content);
    change(content);
    sources[0].artifact = clone(
      await commitVersion(createArtifact('document', 'Unsupported', content), null, 'fixture'),
    );
    sources[0].versionId = sources[0].artifact.versions[0].versionId;
    const plan = await prepareDocumentEpub(sources, metadata);
    expect(plan.report.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect((await encodeDocumentEpub(plan, consent(plan))).status).toBe('blocked');
  }
  const sources = await chapters();
  sources[0].versionId = 'missing';
  const missing = await prepareDocumentEpub(sources, metadata);
  expect(missing.report.sources.requests[0].versionId).toBe('missing');
  expect((await encodeDocumentEpub(missing, consent(missing))).status).toBe('blocked');
  sources[0].versionId = sources[0].artifact.versions[0].versionId;
  sources[0].artifact.versions[0].content.blocks[0].text = 'corrupt';
  const corrupt = await prepareDocumentEpub(sources, metadata);
  expect((await encodeDocumentEpub(corrupt, consent(corrupt))).status).toBe('blocked');
});
const png = 'data:image/png;base64,iVBORw0KGgo=';
it.each(['horizontal-tb', 'vertical-rl'] as const)(
  'packages embedded images with alt and caption in %s EPUB, and refuses remote images',
  async (writingMode) => {
    const sources = await withContent((content) => {
      content.page = { size: 'A4', margin: 64, writingMode };
      content.blocks.push({
        id: 'ordinary-image',
        type: 'image',
        text: '',
        src: png,
        alt: 'Map < 1',
        caption: '港の地図 & 坂',
        width: 500,
      });
    });
    const before = canonicalJson(sources);
    const plan = await prepareDocumentEpub(sources, metadata);
    expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // One image used by three chapters is packaged once.
    expect(plan.report.resources).toEqual([
      expect.objectContaining({
        path: 'EPUB/images/image-1.png',
        mediaType: 'image/png',
        bytes: 8,
      }),
    ]);
    const result = await encodeDocumentEpub(plan, consent(plan));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const files = unzipSync(result.bytes);
    expect([...files['EPUB/images/image-1.png']]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chapter = strFromU8(files['EPUB/chapter-002.xhtml']);
    expect(chapter).toContain(
      '<img src="images/image-1.png" alt="Map &lt; 1" width="500"/><figcaption>港の地図 &amp; 坂</figcaption></figure>',
    );
    expect(strFromU8(files['EPUB/package.opf'])).toContain(
      '<item id="resource-1" href="images/image-1.png" media-type="image/png"/>',
    );
    expect(canonicalJson(sources)).toBe(before);

    const remote = await withContent((content) => {
      content.page = { size: 'A4', margin: 64, writingMode };
      content.blocks.push({
        id: 'remote',
        type: 'image',
        text: '',
        src: 'https://example.com/a.png',
      });
    });
    const refused = await prepareDocumentEpub(remote, metadata);
    expect(refused.report.diagnostics.filter((d) => d.severity === 'error')).toEqual(
      [0, 1, 2].map((i) =>
        expect.objectContaining({
          code: 'IMAGE_SOURCE_UNSUPPORTED',
          effect: 'blocked',
          address: { domain: 'document', blockId: `sequence:${i}:remote` },
        }),
      ),
    );
    const blocked = await encodeDocumentEpub(refused, consent(refused));
    expect(blocked.status).toBe('blocked');
    expect(blocked).not.toHaveProperty('bytes');
  },
);
it("keeps each chapter's writing mode when vertical and horizontal chapters are mixed", async () => {
  const sources = await chapters();
  const content = clone(sources[2].artifact.draft.content);
  content.page = { size: 'A4', margin: 64, writingMode: 'vertical-rl' };
  content.blocks[1].indent = 1;
  sources[2].artifact = clone(
    await commitVersion(createArtifact('document', 'Vertical', content), null, 'fixture'),
  );
  sources[2].versionId = sources[2].artifact.versions[0].versionId;
  const plan = await prepareDocumentEpub(sources, metadata);
  expect(plan.report.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'MIXED_WRITING_MODE',
      severity: 'warning',
      requiresAcceptance: true,
    }),
  );
  expect(plan.report.format).toBe('epub3-horizontal');
  expect(plan.report.chapters.map((c) => c.writingMode)).toEqual([
    'horizontal-tb',
    'horizontal-tb',
    'vertical-rl',
  ]);
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  const files = unzipSync(result.bytes);
  const read = (p: string) => strFromU8(files[p]);
  expect(read('EPUB/chapter-001.xhtml')).toContain('lang="ja" class="horizontal">');
  expect(read('EPUB/chapter-003.xhtml')).toContain('lang="ja" class="vertical">');
  expect(read('EPUB/chapter-003.xhtml')).toContain('margin-top:1.5em;');
  expect(read('EPUB/style.css')).toContain('html.vertical { writing-mode: vertical-rl;');
  expect(read('EPUB/package.opf')).toContain('page-progression-direction="ltr"');
});
it('keeps web, mail and in-book links, resolving in-book targets to their chapter', async () => {
  const sources = await withContent((d, n) => {
    d.blocks[1].rich = [
      { text: 'web', link: 'https://example.com/?a=1&b=2' },
      { text: 'mail', link: 'mailto:a@example.com' },
      { text: 'here', link: '#title' },
      { text: 'there', link: n === 0 ? '#only-in-third' : '#title' },
      { text: 'gone', link: '#hidden' },
    ];
    d.blocks[1].text = 'webmailheretheregone';
    if (n === 2) d.blocks.push({ id: 'only-in-third', type: 'paragraph', text: '終わり' });
  });
  const plan = await prepareDocumentEpub(sources, metadata);
  expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(plan.report.diagnostics.filter((d) => d.code === 'LINK_TARGET_MISSING')).toHaveLength(3);
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  const files = unzipSync(result.bytes);
  const first = strFromU8(files['EPUB/chapter-001.xhtml']);
  expect(first).toContain('<a href="https://example.com/?a=1&amp;b=2">web</a>');
  expect(first).toContain('<a href="mailto:a@example.com">mail</a>');
  expect(first).toContain('<a href="chapter-001.xhtml#block-1">here</a>');
  expect(first).toContain('<a href="chapter-003.xhtml#block-4">there</a>');
  // A hidden target is not in the book: the text stays, without a link.
  expect(first).toContain('</a>gone</p>');
  expect(strFromU8(files['EPUB/chapter-002.xhtml'])).toContain(
    '<a href="chapter-002.xhtml#block-1">here</a>',
  );
});
it('embeds Host-chosen fonts with @font-face and refuses bytes that do not match the format', async () => {
  const otf = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1, 2, 3]);
  const sources = await withContent((d) => {
    d.blocks[1].style = { ...d.blocks[1].style, fontFamily: 'Noto Sans Mono CJK JP' };
  });
  const fonts = [{ family: 'Book Serif', format: 'otf' as const, data: otf }];
  const plan = await prepareDocumentEpub(sources, metadata, undefined, { fonts });
  otf[4] = 9; // Bytes are captured when the plan is prepared.
  expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(plan.report.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'FONT_NOT_EMBEDDED', severity: 'warning' }),
  );
  expect(plan.report.resources).toEqual([
    expect.objectContaining({ path: 'EPUB/fonts/font-1.otf', mediaType: 'font/otf', bytes: 7 }),
  ]);
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  const files = unzipSync(result.bytes);
  expect([...files['EPUB/fonts/font-1.otf']]).toEqual([0x4f, 0x54, 0x54, 0x4f, 1, 2, 3]);
  const css = strFromU8(files['EPUB/style.css']);
  expect(css).toContain(
    '@font-face { font-family: "Book Serif"; src: url("fonts/font-1.otf") format("opentype"); font-weight: 400; }',
  );
  expect(css).toContain('font-family: "Book Serif", serif;');
  expect(strFromU8(files['EPUB/package.opf'])).toContain('media-type="font/otf"');
  for (const bad of [
    { family: 'Wrong', format: 'woff2' as const, data: new Uint8Array([0x4f, 0x54, 0x54, 0x4f]) },
    { family: 'x"; } body { color: red', format: 'otf' as const, data: otf },
  ]) {
    const refused = await prepareDocumentEpub(sources, metadata, undefined, { fonts: [bad] });
    expect(refused.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'INVALID_FONT', severity: 'error' }),
    );
  }
});
async function withContent(change: (d: DocumentContent, index: number) => void) {
  const sources = await chapters();
  for (const [i, source] of sources.entries()) {
    const content = clone(source.artifact.draft.content);
    change(content, i);
    source.artifact = clone(
      await commitVersion(createArtifact('document', `第${i + 1}章`, content), null, 'fixture'),
    );
    source.versionId = source.artifact.versions[0].versionId;
  }
  return sources;
}
const ruby = (d: DocumentContent) => {
  d.blocks[1] = {
    id: 'scene',
    type: 'paragraph',
    text: '東京の12時、2026年。',
    rich: [
      { text: '東', ruby: { text: 'とうきょう', base: '東京' }, bold: true },
      { text: '京', ruby: { text: 'とうきょう', base: '東京' } },
      { text: 'の12時、2026年。' },
    ],
    indent: 1,
  };
};
it('keeps ruby in a horizontal EPUB without setting digits upright', async () => {
  const plan = await prepareDocumentEpub(await withContent(ruby), metadata);
  expect(plan.report.format).toBe('epub3-horizontal');
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  const files = unzipSync(result.bytes);
  expect(strFromU8(files['EPUB/chapter-001.xhtml'])).toContain(
    '<ruby><strong>東</strong>京<rt>とうきょう</rt></ruby>の12時、2026年。',
  );
  expect(strFromU8(files['EPUB/chapter-001.xhtml'])).toContain('margin-left:1.5em;');
  expect(strFromU8(files['EPUB/package.opf'])).toContain('page-progression-direction="ltr"');
});
it('keeps 傍点 in an EPUB, on the other side of the text under a ruby', async () => {
  const plan = await prepareDocumentEpub(
    await withContent((d) => {
      d.blocks[1] = {
        id: 'scene',
        type: 'paragraph',
        text: '本当に東京',
        rich: [
          { text: '本当に', emphasisDots: true },
          { text: '東京', ruby: { text: 'とうきょう', base: '東京' }, emphasisDots: true },
        ],
      };
    }),
    metadata,
  );
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  await mkdir('/tmp/epub-validation', { recursive: true });
  await writeFile('/tmp/epub-validation/emphasis.epub', result.bytes);
  const chapter = strFromU8(unzipSync(result.bytes)['EPUB/chapter-001.xhtml']);
  expect(chapter).toContain(
    '<span style="-epub-text-emphasis-style:filled sesame;text-emphasis:filled sesame">本当に</span>',
  );
  expect(chapter).toContain(
    '<ruby><span style="-epub-text-emphasis-style:filled sesame;-epub-text-emphasis-position:under left;text-emphasis:filled sesame;text-emphasis-position:under left">東京</span><rt>とうきょう</rt></ruby>',
  );
});
it('encodes an all-vertical sequence as a right-to-left vertical EPUB with ruby and upright digits', async () => {
  const plan = await prepareDocumentEpub(
    await withContent((d) => {
      ruby(d);
      d.page = { size: 'A4', margin: 64, writingMode: 'vertical-rl' };
    }),
    metadata,
  );
  expect(plan.report).toMatchObject({
    format: 'epub3-vertical',
    exporterVersion: 'epub-vertical/1.1.0',
  });
  expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(plan.report.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'REFLOW_FONT_DIFFERENCE', requiresAcceptance: true }),
  );
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  const files = unzipSync(result.bytes);
  const read = (p: string) => strFromU8(files[p]);
  expect(read('EPUB/chapter-001.xhtml')).toContain(
    '<ruby><strong>東</strong>京<rt>とうきょう</rt></ruby>の<span class="tcy">12</span>時、2026年。',
  );
  expect(read('EPUB/chapter-001.xhtml')).toContain('margin-top:1.5em;');
  expect(read('EPUB/style.css')).toContain('writing-mode: vertical-rl');
  expect(read('EPUB/chapter-001.xhtml')).toContain('class="vertical"');
  expect(read('EPUB/package.opf')).toContain('page-progression-direction="rtl"');
  await mkdir('/tmp/epub-validation', { recursive: true });
  await writeFile('/tmp/epub-validation/vertical.epub', result.bytes);
});
it('sets digits upright only within one span, in linear time, and refuses non-XML readings', async () => {
  const many = Array.from({ length: 20000 }, (_, i) =>
    i % 2 ? { text: '字' } : { text: '1', bold: true },
  );
  const sources = await withContent((d) => {
    d.page = { size: 'A4', margin: 64, writingMode: 'vertical-rl' };
    d.blocks[1] = {
      id: 'scene',
      type: 'paragraph',
      text: '1' + '2時' + many.map((s) => s.text).join(''),
      rich: [{ text: '1' }, { text: '2時', italic: true }, ...many],
    };
  });
  const started = performance.now();
  const plan = await prepareDocumentEpub(sources, metadata);
  expect(performance.now() - started).toBeLessThan(5000);
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  const chapter = strFromU8(unzipSync(result.bytes)['EPUB/chapter-001.xhtml']);
  expect(chapter).toContain(
    '<p id="block-2">1<em>2時</em><strong><span class="tcy">1</span></strong>字',
  );
  const bad = await prepareDocumentEpub(
    await withContent((d) => {
      d.blocks[1].rich![0] = {
        text: '日本語',
        bold: true,
        ruby: { text: 'に\u0000', base: '日本語' },
      };
    }),
    metadata,
  );
  expect(bad.report.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'INVALID_XML_TEXT', severity: 'error' }),
  );
  expect((await encodeDocumentEpub(bad, consent(bad))).status).toBe('blocked');
});
it('refuses malformed metadata without invoking accessors and respects Cancel', async () => {
  const sources = await chapters();
  let invoked = false;
  const getter = Object.defineProperty({ ...metadata }, 'title', {
    enumerable: true,
    get() {
      invoked = true;
      return 'bad';
    },
  });
  const options = clone(metadata);
  Object.defineProperty(options.creators, '0', {
    enumerable: true,
    get() {
      invoked = true;
      return 'bad';
    },
  });
  for (const raw of [
    getter,
    options,
    { ...metadata, modified: '2026-02-31T00:00:00Z' },
    { ...metadata, title: '\ud800' },
    { ...metadata, creators: new Array(2) },
  ]) {
    const plan = await prepareDocumentEpub(sources, raw);
    expect(plan.report.diagnostics.some((d) => d.code === 'INVALID_METADATA')).toBe(true);
  }
  expect(invoked).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(prepareDocumentEpub(sources, metadata, controller.signal)).rejects.toThrow();
  const plan = await prepareDocumentEpub(sources, metadata);
  expect((await encodeDocumentEpub(plan, consent(plan), controller.signal)).status).toBe(
    'cancelled',
  );
});
it('keeps the EPUB API headless and does not bundle the DOCX encoder or React', async () => {
  const bundle = await build({
    stdin: {
      contents: "export * from '@editor-platform/document-export/epub'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    write: false,
    metafile: true,
  });
  expect(
    Object.keys(bundle.metafile!.inputs).filter((p) =>
      /react-dom|\.tsx$|\.css$|node_modules\/docx\//.test(p),
    ),
  ).toEqual([]);
});

it('blocks empty chapter labels, invalid BCP47 metadata and a cancelled in-flight capture', async () => {
  const sources = await chapters();
  sources[0].artifact.name = ' ';
  const empty = await prepareDocumentEpub(sources, metadata);
  expect(empty.report.diagnostics.some((d) => d.code === 'INVALID_CHAPTER_TITLE')).toBe(true);
  expect((await encodeDocumentEpub(empty, consent(empty))).status).toBe('blocked');
  const invalid = await prepareDocumentEpub(await chapters(), {
    ...metadata,
    language: 'en-abc-x',
  });
  expect(invalid.report.diagnostics.some((d) => d.code === 'INVALID_METADATA')).toBe(true);
  const controller = new AbortController();
  const pending = prepareDocumentEpub(await chapters(), metadata, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

it('preserves explicit normal-weight spans inside a bold native block', async () => {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'weights',
        type: 'paragraph',
        text: '太字通常',
        style: { fontWeight: 700 },
        rich: [{ text: '太字' }, { text: '通常', bold: false }],
      },
    ],
  };
  const artifact = await commitVersion(
    createArtifact('document', 'Weights', content),
    null,
    'fixture',
  );
  const plan = await prepareDocumentEpub(
    [{ artifact, versionId: artifact.versions[0].versionId }],
    metadata,
  );
  expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const result = await encodeDocumentEpub(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  const html = strFromU8(unzipSync(result.bytes)['EPUB/chapter-001.xhtml']);
  expect(html).toContain('style="font-weight:700;"');
  expect(html).toContain('太字<span style="font-weight:400">通常</span>');
});
