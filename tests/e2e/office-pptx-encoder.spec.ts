import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { test, expect } from './fixtures';
import { pptxGoldenDeck } from '../fixtures/office/pptx';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
} from '@editor-platform/slide-export';
import { createPptxRasterAdapter } from '@editor-platform/slide-export/raster';
import { prepareOfficeFonts, imageDataUri } from '@editor-platform/office-adapters';
import { decodeNodeOfficeImage, nodeOfficeImagePng } from '@editor-platform/office-adapters/node';
import { drawingSvg } from '@editor-platform/editor-core';
import { slidePaintOrder, slideDrawing } from '@editor-platform/slide/model';
import type { ExportFontProfile } from '@editor-platform/export-core';
import type { OfficeFontManifest } from '@editor-platform/office-adapters';

test('G01–G09 public PPTX API has matching Node/browser native output and renders the fixed Japanese font', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const root = 'apps/playground/public/office-fonts/';
  const manifest = JSON.parse(await readFile(root + 'manifest.json', 'utf8')) as OfficeFontManifest;
  const fonts = await prepareOfficeFonts(
    manifest,
    await Promise.all(manifest.faces.map((f) => readFile(root + f.file))),
  );
  const wasm = new Uint8Array(await readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm'));
  const rasterize = await createPptxRasterAdapter(wasm, fonts, nodeOfficeImagePng);
  const images = {} as Record<'png' | 'jpeg' | 'gif' | 'webp', string>;
  for (const format of ['png', 'jpeg', 'gif', 'webp'] as const)
    images[format] = imageDataUri(
      await decodeNodeOfficeImage(
        new Uint8Array(await readFile(`tests/fixtures/office/images/quadrants.${format}`)),
      ),
    );
  const deck = pptxGoldenDeck(images);
  const basis = { kind: 'confirmed' as const, artifactId: 'PRIVATE_HOST_SENTINEL', revision: 17 };
  const options = {
    pageIds: 'all' as const,
    includeHiddenSlides: false,
    includeNotes: false,
    fontProfileId: manifest.id,
    fallback: 'element-png' as const,
  };
  const plan = await prepareSlidePptx(await captureSlideExportSnapshot(deck, basis), options, {
    resolveFont: async () => structuredClone(fonts.profile) as ExportFontProfile,
    resolveAsset: async (source) =>
      decodeNodeOfficeImage(
        new Uint8Array(Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')),
      ),
    rasterize,
  });
  const expected = await encodeSlidePptx(plan, {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: plan.report.diagnostics
      .filter((d) => d.requiresAcceptance)
      .map((d) => d.id),
  });
  expect(expected.status).toBe('ok');
  if (expected.status !== 'ok') throw Error('Node encoder failed');
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { captureSlideExportSnapshot, prepareSlidePptx, encodeSlidePptx } from '@editor-platform/slide-export';
    import { createPptxRasterAdapter } from '@editor-platform/slide-export/raster';
    import { prepareOfficeFonts, imageDataUri } from '@editor-platform/office-adapters';
    import { installBrowserOfficeFonts, decodeBrowserOfficeImage, browserOfficeImagePng } from '@editor-platform/office-adapters/browser';
    const manifest = await (await fetch('/office-fonts/manifest.json')).json();
    const files = await Promise.all(manifest.faces.map(async f => new Uint8Array(await (await fetch('/office-fonts/'+f.file)).arrayBuffer())));
    const fonts = await prepareOfficeFonts(manifest, files);
    await installBrowserOfficeFonts(fonts);
    const wasm = new Uint8Array(await (await fetch('/office-test-renderer.wasm')).arrayBuffer());
    const rasterize = await createPptxRasterAdapter(wasm, fonts, browserOfficeImagePng);
    window.officeEncodeProbe = async ({deck,basis,options}) => {
      const plan = await prepareSlidePptx(await captureSlideExportSnapshot(deck,basis), options, {
        resolveFont: async () => structuredClone(fonts.profile),
        resolveAsset: async (source) => decodeBrowserOfficeImage(Uint8Array.from(atob(source.slice(source.indexOf(',')+1)),c=>c.charCodeAt(0))), rasterize
      });
      const result = await encodeSlidePptx(plan,{planHash:plan.report.planHash,acceptedDiagnosticIds:plan.report.diagnostics.filter(d=>d.requiresAcceptance).map(d=>d.id)});
      if (result.status !== 'ok') throw Error(JSON.stringify(result));
      const data = imageDataUri({bytes:result.bytes,mime:'image/png'}).split(',')[1];
      return { report:result.report,data };
    };
    document.body.dataset.ready = 'true';
  `,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  });
  await page.route('**/office-test-renderer.wasm', (route) =>
    route.fulfill({ contentType: 'application/wasm', body: Buffer.from(wasm) }),
  );
  await page.goto('/');
  await page.setContent('<main id="office-reference" style="width:960px;height:540px"></main>');
  await page.addScriptTag({ type: 'module', content: bundled.outputFiles[0].text });
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const actual = await page.evaluate(
    async (input) => {
      const encode = (
        window as unknown as {
          officeEncodeProbe: (input: unknown) => Promise<{ report: unknown; data: string }>;
        }
      ).officeEncodeProbe;
      return encode(input);
    },
    // The probe validates its own input; do not recursively instantiate Playwright's
    // serialization type through retained reusable-definition JSON.
    { deck, basis, options } as unknown,
  );
  const files = unzipSync(Uint8Array.from(Buffer.from(actual.data, 'base64'))),
    nodeFiles = unzipSync(expected.bytes);
  // Hashes identify actual resolved PNG bytes; different image codecs may produce different PNGs.
  // Every declared semantic diagnostic, source address, native part, selection and count must match.
  expect({ ...(actual.report as object), planHash: null }).toEqual({
    ...expected.report,
    planHash: null,
  });
  for (const name of Object.keys(nodeFiles).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ))
    expect(strFromU8(files[name])).toBe(strFromU8(nodeFiles[name]));
  const evidence = process.env.OFFICE_BROWSER_EVIDENCE ?? testInfo.outputPath('office');
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/browser-golden.pptx`, Buffer.from(actual.data, 'base64'));
  await writeFile(`${evidence}/browser-golden.report.json`, JSON.stringify(actual.report, null, 2));
  await writeFile(`${evidence}/node-golden.pptx`, expected.bytes);
  for (const [index, slide] of deck.slides.entries()) {
    const svg = drawingSvg(
      slidePaintOrder(slide).map(slideDrawing),
      { x: 0, y: 0, width: deck.width, height: deck.height },
      slide.background,
    );
    await page.locator('#office-reference').evaluate((element, svg) => {
      element.innerHTML = svg;
    }, svg);
    await page
      .locator('#office-reference')
      .screenshot({ path: `${evidence}/browser-reference-${index + 1}.png` });
    expect(
      await page.evaluate(() => document.fonts.check('28px "Noto Sans CJK JP"', '日本語')),
    ).toBe(true);
  }
});
