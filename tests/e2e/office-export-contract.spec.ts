import { build } from 'esbuild';
import { test, expect } from './fixtures';

test('V2.1 public pure capture/preflight contracts execute in a browser for Slide and Document', async ({
  page,
}) => {
  // Bundle public entrypoints independently, with no playground model or renderer imports.
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { captureExportSnapshot, acceptsExport } from '@editor-platform/export-core';
    import { captureSlideExportSnapshot, prepareSlidePptx } from '@editor-platform/slide-export';
    import { createDeck } from '@editor-platform/slide/model';
    import { createDocument } from '@editor-platform/document/model';
    const deck = createDeck(), doc = createDocument();
    const captured = captureSlideExportSnapshot(deck, { kind:'confirmed',artifactId:'slide',revision:4 });
    deck.width = 222;
    const snapshot = await captured;
    const documentSnapshot = await captureExportSnapshot(doc, { kind:'saved-version',artifactId:'document',versionId:'v1' });
    const plan = await prepareSlidePptx(snapshot, {
      pageIds:'all',includeHiddenSlides:false,includeNotes:false,fontProfileId:'contract',fallback:'reject'
    }, { resolveFont: async () => ({ id:'contract',family:'Noto Sans CJK JP',version:'test',license:'OFL-1.1',verified:true,
      faces:[{weight:'regular',sha256:'a'.repeat(64)},{weight:'bold',sha256:'b'.repeat(64)}],glyphRanges:[[0,0x10ffff]] }) });
    const output = { width:snapshot.content.width, revision:snapshot.basis.revision,
      documentBasis:documentSnapshot.basis.kind, documentFrozen:Object.isFrozen(documentSnapshot.content.blocks),
      errors:plan.report.diagnostics.filter(d=>d.severity==='error'),
      accepted:acceptsExport(plan.report,{planHash:plan.report.planHash,acceptedDiagnosticIds:[]}) };
    document.querySelector('output').textContent = JSON.stringify(output);
  `,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  });
  // Real secure-context Web Crypto; no external asset/font/network adapter is invoked.
  await page.goto('/');
  await page.setContent('<output aria-label="Contract result"></output>');
  await page.addScriptTag({ type: 'module', content: result.outputFiles[0].text });
  await expect(page.getByLabel('Contract result')).not.toBeEmpty();
  expect(JSON.parse((await page.getByLabel('Contract result').textContent())!)).toEqual({
    width: 960,
    revision: 4,
    documentBasis: 'saved-version',
    documentFrozen: true,
    errors: [],
    accepted: true,
  });
});
