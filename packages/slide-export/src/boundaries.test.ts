import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { captureSlideExportSnapshot, prepareSlidePptx } from '@editor-platform/slide-export';
import { contractDeck, contractOptions, contractFont } from './fixtures';

for (const platform of ['node', 'browser'] as const)
  it(`public pure output entrypoints bundle for ${platform} without a UI or Office encoder`, async () => {
    const result = await build({
      stdin: {
        contents: `
      import { captureExportSnapshot } from '@editor-platform/export-core';
      import { prepareSlidePptx } from '@editor-platform/slide-export/plan';
      export { captureExportSnapshot, prepareSlidePptx };`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform,
      format: 'esm',
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(
      inputs.some((p) => /react|canvas-ui|editor-ui|pptxgenjs|document-export|docx/.test(p)),
    ).toBe(false);
    expect(result.outputFiles[0].text).not.toMatch(/\b(window|document|fetch)\./);
  });

it('G15 checks both page-size boundaries and the page/object caps without reducing content', async () => {
  const adapters = { resolveFont: async () => contractFont };
  const prepare = async (deck = contractDeck()) =>
    prepareSlidePptx(
      await captureSlideExportSnapshot(deck, { kind: 'local-draft', artifactId: 'limits' }),
      contractOptions,
      adapters,
    );
  for (const [side, blocked] of [
    [99, true],
    [100, false],
    [101, false],
    [3839, false],
    [3840, false],
    [3841, true],
  ] as const) {
    const deck = contractDeck([]);
    deck.width = side;
    const plan = await prepare(deck);
    expect(plan.report.diagnostics.some((d) => d.code === 'PAGE_SIZE_UNSUPPORTED')).toBe(blocked);
  }
  for (const count of [99, 100, 101]) {
    const deck = contractDeck([]);
    deck.slides = Array.from({ length: count }, (_, i) => ({ ...deck.slides[0], id: `page-${i}` }));
    const plan = await prepare(deck);
    expect(plan.report.diagnostics.some((d) => d.code === 'LIMIT_EXCEEDED')).toBe(count > 100);
    if (count <= 100) expect(plan.report.selectedPageIds).toHaveLength(count);
  }
  for (const count of [9999, 10000, 10001]) {
    const deck = contractDeck([]);
    deck.slides[0].objects = Array.from({ length: count }, (_, i) => ({
      id: `object-${i}`,
      type: 'shape',
      shape: 'rectangle',
      text: '',
      fill: '#ffffff',
      bounds: { x: i % 900, y: i % 500, width: 1, height: 1 },
    }));
    const plan = await prepare(deck);
    expect(plan.report.diagnostics.some((d) => d.code === 'LIMIT_EXCEEDED')).toBe(count > 10000);
    if (count <= 10000) expect(plan.report.elements).toHaveLength(count);
    expect(deck.slides[0].objects).toHaveLength(count);
  }
});
