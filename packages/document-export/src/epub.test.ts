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
it('rejects unsupported ruby/links/blocks, invalid XML, corrupt or missing exact versions without partial bytes', async () => {
  for (const change of [
    (d: DocumentContent) => {
      d.blocks[1].rich![0] = { text: '字', ruby: 'じ' } as never;
    },
    (d: DocumentContent) => {
      d.blocks[1].rich![0].link = '#scene';
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
