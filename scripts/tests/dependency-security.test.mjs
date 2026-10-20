import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { verifyDependencyLock, inspectDependencyModules } from '../dev/dependency-security.mjs';

const lock = () =>
  JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
test('every installed Mermaid/sanitizer/math/PDF.js copy has the declared security pin', () => {
  verifyDependencyLock(lock());
});
test('a patched root does not hide the old workspace Mermaid regression', () => {
  const value = lock();
  value.packages['packages/document/node_modules/mermaid'] = { version: '11.12.0' };
  assert.throws(() => verifyDependencyLock(value), /Unsafe dependency lock.*document/);
});
test('stale KaTeX and sanitizer copies fail even when not top-level', () => {
  for (const [name, version] of [
    ['katex', '0.16.47'],
    ['dompurify', '3.0.0'],
    ['pdfjs-dist', '5.6.205'],
  ]) {
    const value = lock();
    value.packages[`packages/document/node_modules/${name}`] = { version };
    assert.throws(() => verifyDependencyLock(value), /Unsafe dependency lock/);
  }
});
test('a stale PDF.js workspace lock fails even with a patched root', () => {
  const value = lock();
  value.packages['packages/review-surfaces'].dependencies['pdfjs-dist'] = '5.6.205';
  assert.throws(() => verifyDependencyLock(value), /PDF.js manifest\/lock mismatch/);
});
test('emitted PDF.js core checks the installed security pin', () => {
  assert.throws(
    () =>
      inspectDependencyModules(['/repo/node_modules/pdfjs-dist/build/pdf.mjs'], undefined, () => ({
        version: '5.6.205',
      })),
    /Unsafe emitted dependency: pdfjs-dist/,
  );
});
test('emitted graph refuses the unused parser, standard viewer and bundled old math', () => {
  for (const path of [
    'image-size/dist/index.js',
    'pdfjs-dist/web/pdf_viewer.mjs',
    'pdfjs-dist/build/pdf.sandbox.mjs',
    'mermaid/dist/mermaid.esm.min.mjs',
  ])
    assert.throws(
      () => inspectDependencyModules(['/repo/node_modules/' + path]),
      /Unexpected|core entry/,
    );
});
test('emitted graph checks actual package bytes rather than only the lock', () => {
  assert.throws(
    () =>
      inspectDependencyModules(
        ['/repo/node_modules/mermaid/dist/mermaid.core.mjs'],
        undefined,
        () => ({ version: '11.12.0' }),
      ),
    /Unsafe emitted dependency/,
  );
  const versions = { mermaid: '11.17.2', katex: '0.18.2', dompurify: '3.4.16' };
  const report = inspectDependencyModules(
    Object.keys(versions).map(
      (name) =>
        `/repo/node_modules/${name}/${name === 'mermaid' ? 'dist/mermaid.core.mjs' : 'index.js'}`,
    ),
    versions,
    (path) => ({ version: versions[path.split('/').at(-2)] }),
  );
  assert.equal(report.coreMermaid, true);
  assert.equal(report.packages.length, 3);
});
test('the pinned Node PPTX exporter never reaches the unused image-size parser', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: "import PptxGenJS from 'pptxgenjs'; export {PptxGenJS};", resolveDir: root },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    metafile: true,
  });
  const modules = Object.keys(result.metafile.inputs).map((path) => resolve(root, path));
  assert.ok(modules.some((path) => path.includes('/node_modules/pptxgenjs/')));
  assert.equal(inspectDependencyModules(modules).imageSizeReachable, false);
});
