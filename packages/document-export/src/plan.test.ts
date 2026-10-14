import { expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { contentHash } from '@editor-platform/artifact-core';
import type { DocumentListItem } from '@editor-platform/document/model';
import { captureDocumentExportSnapshot, prepareDocumentDocx, encodeDocumentDocx } from './index';
import { contractDocument, contractFont, contractOptions, contractPng } from './fixtures';
import type { DocxAdapters, DocumentDocxPlan } from './types';
const consent = (p: DocumentDocxPlan) => ({
  planHash: p.report.planHash,
  acceptedDiagnosticIds: p.report.diagnostics.filter((d) => d.requiresAcceptance).map((d) => d.id),
});
async function prepare(
  content = contractDocument(),
  options = contractOptions,
  services: DocxAdapters = {},
) {
  return prepareDocumentDocx(
    await captureDocumentExportSnapshot(content, {
      kind: 'confirmed',
      artifactId: 'PRIVATE_ARTIFACT',
      revision: 5,
    }),
    options,
    { resolveFont: async (id) => contractFont(id), ...services },
  );
}
it('D10 owns capture and prepare inputs before the first await; output is read-only', async () => {
  const source = contractDocument(),
    original = await contentHash(source);
  const snapshotPromise = captureDocumentExportSnapshot(source, {
    kind: 'confirmed',
    artifactId: 'a',
    revision: 3,
  });
  source.blocks[0].text = 'later';
  const snapshot = await snapshotPromise;
  expect(snapshot.basis.contentHash).toBe(original);
  const settings = { ...contractOptions };
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const pending = prepareDocumentDocx(snapshot, settings, {
    resolveFont: async (id) => {
      await wait;
      return contractFont(id);
    },
  });
  settings.previewBlocks = 'source';
  release();
  const p = await pending;
  expect(Object.isFrozen(p.report.diagnostics)).toBe(true);
  expect((await encodeDocumentDocx(p, consent(p))).status).toBe('ok');
  expect(source.blocks[0].text).toBe('later');
  expect(p.report.basis).toEqual({
    kind: 'confirmed',
    artifactId: 'a',
    revision: 3,
    contentHash: original,
  });
});
it('D08/D10 explicitly reports source conversion, requires exact consent and never waives errors', async () => {
  const content = contractDocument();
  content.blocks.push({ id: 'html', type: 'html', text: '<script>globalThis.attacked=1</script>' });
  const blocked = await prepare(content);
  expect(
    blocked.report.diagnostics.some(
      (d) => d.code === 'BLOCK_UNSUPPORTED' && d.address?.blockId === 'html',
    ),
  ).toBe(true);
  expect((await encodeDocumentDocx(blocked, consent(blocked))).status).toBe('blocked');
  const p = await prepare(content, { ...contractOptions, previewBlocks: 'source' });
  expect(p.report.diagnostics.some((d) => d.code === 'PREVIEW_AS_SOURCE')).toBe(true);
  expect(
    (await encodeDocumentDocx(p, { planHash: p.report.planHash, acceptedDiagnosticIds: [] }))
      .status,
  ).toBe('blocked');
  expect((await encodeDocumentDocx(p, { ...consent(p), planHash: 'other' })).status).toBe(
    'blocked',
  );
  expect(
    (
      await encodeDocumentDocx(p, {
        ...consent(p),
        acceptedDiagnosticIds: [...consent(p).acceptedDiagnosticIds, 'unknown'],
      })
    ).status,
  ).toBe('blocked');
  expect(
    (await encodeDocumentDocx({ report: p.report } as DocumentDocxPlan, consent(p))).status,
  ).toBe('failed');
  expect((await encodeDocumentDocx(p, consent(p))).status).toBe('ok');
});
it('D07/D10 owns image bytes, refetches only for a new plan, and blocks broken assets', async () => {
  const content = contractDocument();
  content.blocks.push({ id: 'image', type: 'image', text: '', src: 'https://example.com/a.png' });
  const image = contractPng(),
    resolveAsset = vi.fn(async () => image);
  const p = await prepare(content, contractOptions, { resolveAsset });
  const originalBytes = new Uint8Array(image.bytes);
  image.bytes.fill(0);
  const encoded = await encodeDocumentDocx(p, consent(p));
  expect(encoded.status).toBe('ok');
  if (encoded.status !== 'ok') throw Error('Missing output');
  const files = unzipSync(encoded.bytes);
  const media = Object.keys(files).find((p) => p.startsWith('word/media/') && p.endsWith('.png'))!;
  expect(files[media]).toEqual(originalBytes);
  expect(resolveAsset).toHaveBeenCalledTimes(1);
  const next = await prepare(content, contractOptions, { resolveAsset });
  expect(next.report.planHash).not.toBe(p.report.planHash);
  expect(next.report.diagnostics.some((d) => d.code === 'ASSET_FAILED')).toBe(true);
});

it('D02 rejects XML-incompatible text and malformed inline flags before encoding', async () => {
  for (const value of [
    'control' + String.fromCharCode(0),
    'surrogate' + String.fromCharCode(0xd800),
  ]) {
    const c = contractDocument();
    c.blocks[0].text = value;
    const p = await prepare(c);
    expect(p.report.diagnostics.some((d) => d.code === 'TEXT_INVALID')).toBe(true);
    expect((await encodeDocumentDocx(p, consent(p))).status).toBe('blocked');
  }
  const c = contractDocument();
  c.blocks[1].rich![0].bold = 'false' as never;
  const p = await prepare(c);
  expect(p.report.diagnostics.some((d) => d.code === 'INVALID_CONTENT')).toBe(true);
  expect((await encodeDocumentDocx(p, consent(p))).status).toBe('blocked');
});
it('D03 accepts level 8, blocks level 9, and keeps schema-one text lists', async () => {
  const make = (depth: number): DocumentListItem[] => [
    {
      id: `item${depth}`,
      rich: [{ text: `level ${depth}` }],
      ...(depth ? { children: make(depth - 1), childrenType: 'ordered_list' as const } : {}),
    },
  ];
  for (const depth of [8, 9]) {
    const c = contractDocument();
    c.blocks = [{ id: 'list', type: 'numbered-list', text: '', items: make(depth) }];
    const p = await prepare(c);
    expect(p.report.diagnostics.some((d) => d.code === 'LIST_DEPTH_EXCEEDED')).toBe(depth === 9);
  }
  const c = contractDocument();
  c.schemaVersion = 1;
  c.blocks = [{ id: 'old', type: 'check-list', text: '第一\n第二' }];
  const p = await prepare(c);
  expect(p.report.counts.converted).toBe(1);
  expect((await encodeDocumentDocx(p, consent(p))).status).toBe('ok');
});
it.each([1999, 2000, 2001])('D10 top-level block boundary %i', async (n) => {
  const c = contractDocument();
  c.blocks = Array.from({ length: n }, (_, i) => ({ id: String(i), type: 'paragraph', text: '' }));
  const p = await prepare(c);
  expect(p.report.diagnostics.some((d) => d.code === 'LIMIT_EXCEEDED')).toBe(n > 2000);
});
it.each([999999, 1000000, 1000001])('D10 text boundary %i', async (n) => {
  const c = contractDocument();
  c.blocks = [{ id: 'long', type: 'paragraph', text: 'x'.repeat(n) }];
  const p = await prepare(c);
  expect(p.report.diagnostics.some((d) => d.code === 'LIMIT_EXCEEDED')).toBe(n > 1000000);
});
it.each([49999, 50000, 50001])('D10 logical cell boundary %i', async (n) => {
  const c = contractDocument();
  c.blocks = [
    { id: 'table', type: 'table', text: '', cells: Array.from({ length: n }, () => ['']) },
  ];
  const p = await prepare(c);
  expect(p.report.diagnostics.some((d) => d.code === 'TABLE_LIMIT_EXCEEDED')).toBe(n > 50000);
});
it('D08 Mermaid renderer errors and missing glyphs are addressed and cannot be waived', async () => {
  const c = contractDocument();
  c.blocks = [{ id: 'diagram', type: 'mermaid', text: 'invalid syntax' }];
  const p = await prepare(
    c,
    { ...contractOptions, mermaid: 'image' },
    {
      renderMermaid: async () => {
        throw Error('Invalid syntax');
      },
    },
  );
  expect(p.report.diagnostics.find((d) => d.code === 'MERMAID_FAILED')?.address?.blockId).toBe(
    'diagram',
  );
  const glyphs = await prepare(contractDocument(), contractOptions, {
    resolveFont: async (id) => ({ ...contractFont(id), glyphRanges: [[32, 126]] }),
  });
  expect(
    glyphs.report.diagnostics.some(
      (d) => d.code === 'GLYPH_MISSING' && d.address?.blockId === 'PRIVATE_HEADING',
    ),
  ).toBe(true);
});
it('D10 cancellation prevents output and a fresh call can retry', async () => {
  const p = await prepare();
  const controller = new AbortController();
  controller.abort();
  expect((await encodeDocumentDocx(p, consent(p), controller.signal)).status).toBe('cancelled');
  expect((await encodeDocumentDocx(p, consent(p))).status).toBe('ok');
  await expect(
    prepareDocumentDocx(
      await captureDocumentExportSnapshot(contractDocument(), {
        kind: 'local-draft',
        artifactId: 'a',
      }),
      contractOptions,
      {},
      controller.signal,
    ),
  ).rejects.toThrow('cancel');
});
