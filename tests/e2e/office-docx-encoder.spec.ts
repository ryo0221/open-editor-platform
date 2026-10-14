import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
import { docxGoldenDocument } from '../fixtures/office/docx';
import { nodeDocx, docxOptions } from '../fixtures/office/docx-node';
import { docxStructure } from '../fixtures/office/docx-structure';

test('D01–D08 public DOCX Node/browser APIs preserve the same native flow and fixed fonts', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const images = {} as Record<'png' | 'jpeg' | 'gif' | 'webp', string>;
  for (const type of ['png', 'jpeg', 'gif', 'webp'] as const)
    images[type] =
      `data:image/${type};base64,` +
      (await readFile(`tests/fixtures/office/images/quadrants.${type}`)).toString('base64');
  const content = docxGoldenDocument(images);
  const basis = { kind: 'confirmed' as const, artifactId: 'PRIVATE_HOST_SENTINEL', revision: 19 };
  const expected = await nodeDocx(content, basis);
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { captureDocumentExportSnapshot, prepareDocumentDocx, encodeDocumentDocx } from '@editor-platform/document-export';
    import { prepareOfficeFonts } from '@editor-platform/office-adapters';
    import { installBrowserOfficeFonts, fetchOfficeImage, browserOfficeImagePng } from '@editor-platform/office-adapters/browser';
    import { exportHtml } from '@editor-platform/document/model';
    const profiles = new Map();
    for (const file of ['manifest.json','mono-manifest.json']) {
      const manifest = await (await fetch('/office-fonts/'+file)).json();
      const buffers = await Promise.all(manifest.faces.map(async f => new Uint8Array(await (await fetch('/office-fonts/'+f.file)).arrayBuffer())));
      const fonts = await prepareOfficeFonts(manifest,buffers);
      await installBrowserOfficeFonts(fonts); profiles.set(manifest.id,fonts.profile);
    }
    window.docxProbe = async ({content,basis,options}) => {
      const before = JSON.stringify(content);
      const snapshot = captureDocumentExportSnapshot(content,basis);
      const plan = await prepareDocumentDocx(await snapshot,options,{
        resolveFont:async id=>structuredClone(profiles.get(id)),resolveAsset:fetchOfficeImage,imagePng:browserOfficeImagePng
      });
      const result = await encodeDocumentDocx(plan,{planHash:plan.report.planHash,acceptedDiagnosticIds:plan.report.diagnostics.filter(d=>d.requiresAcceptance).map(d=>d.id)});
      if(result.status!=='ok') throw Error(JSON.stringify(result));
      if(before!==JSON.stringify(content)) throw Error('Input mutation');
      const chunk=32768; let binary='';
      for(let i=0;i<result.bytes.length;i+=chunk) binary+=String.fromCharCode(...result.bytes.subarray(i,i+chunk));
      const parsed=new DOMParser().parseFromString(exportHtml(content),'text/html');
      document.querySelector('main').replaceChildren(...parsed.body.childNodes);
      return {report:result.report,data:btoa(binary)};
    };
    document.body.dataset.ready='true';
  `,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  });
  await page.goto('/');
  await page.setContent(
    '<style>main{font:16px/1.6 "Noto Sans CJK JP";max-width:800px;margin:30px auto}table{border-collapse:collapse}td,th{border:1px solid #999;padding:8px}img{max-width:100%}pre,code{font-family:"Noto Sans Mono CJK JP"}pre{white-space:pre-wrap}</style><main></main>',
  );
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const actual = await page.evaluate(
    async (input) =>
      (
        window as unknown as {
          docxProbe(input: unknown): Promise<{ report: unknown; data: string }>;
        }
      ).docxProbe(JSON.parse(input)),
    JSON.stringify({ content, basis, options: docxOptions }),
  );
  const bytes = new Uint8Array(Buffer.from(actual.data, 'base64'));
  expect(docxStructure(bytes)).toEqual(docxStructure(expected.bytes));
  expect({ ...(actual.report as object), planHash: null }).toEqual({
    ...expected.report,
    planHash: null,
  });
  expect(await page.evaluate(() => document.fonts.check('16px "Noto Sans CJK JP"', '日本語'))).toBe(
    true,
  );
  expect(
    await page.evaluate(() => document.fonts.check('16px "Noto Sans Mono CJK JP"', '日本語')),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { EXPORT_EXECUTED?: boolean }).EXPORT_EXECUTED,
    ),
  ).toBeUndefined();
  const root = process.env.DOCX_BROWSER_EVIDENCE ?? info.outputPath('docx');
  await mkdir(root, { recursive: true });
  await writeFile(`${root}/browser-golden.docx`, bytes);
  await writeFile(`${root}/browser-golden.report.json`, JSON.stringify(actual.report, null, 2));
  await writeFile(`${root}/browser-golden.native.json`, JSON.stringify(content, null, 2));
  await writeFile(`${root}/node-golden.docx`, expected.bytes);
  await page.screenshot({ path: `${root}/native-browser.png`, fullPage: true });
});
