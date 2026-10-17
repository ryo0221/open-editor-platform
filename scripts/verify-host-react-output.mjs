import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
// Compile an actual fixture export, then execute only inside an opaque browser sandbox.
const archive = process.argv[2];
if (!archive) throw Error('Pass the react-output.zip downloaded by host-integration.spec.ts');
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'work/issue-33-36/independent-react');
const files = unzipSync(await readFile(archive));
const names = new Set();
for (const name of Object.keys(files)) {
  const path = relative(out, resolve(out, name));
  if (
    !/^[\w./-]+$/.test(name) ||
    isAbsolute(name) ||
    name.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    isAbsolute(path) ||
    path.startsWith('../') ||
    !path ||
    names.has(name.toLowerCase())
  )
    throw Error('Invalid export path');
  names.add(name.toLowerCase());
}
// Each archive is verified on its own; omitted files cannot survive from a prior run.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  const text = strFromU8(bytes);
  if (/\.(tsx|css)$/.test(name) && text.includes('@editor-platform/'))
    throw Error('Editor runtime dependency');
  const path = resolve(out, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
await writeFile(
  resolve(out, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      jsx: 'react-jsx',
      moduleResolution: 'Bundler',
      module: 'ESNext',
      target: 'ES2022',
    },
    include: ['**/*.tsx'],
  }),
);
execFileSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(out, 'tsconfig.json')],
  { stdio: 'pipe' },
);
const result = await build({
  stdin: {
    contents:
      "import React from 'react';import {createRoot} from 'react-dom/client';import {ProductPage} from './ProductPage';createRoot(document.getElementById('root')).render(<ProductPage/>);",
    resolveDir: out,
    loader: 'tsx',
  },
  bundle: true,
  minify: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'empty' },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const hash = createHash('sha256').update(js).digest('base64');
const css = Object.entries(files)
  .filter(([name]) => name.endsWith('.css'))
  .map(([, bytes]) => strFromU8(bytes))
  .join('\n')
  .replace(/<\/style/gi, '<\\/style');
const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'sha256-${hash}';style-src 'unsafe-inline';connect-src 'none';form-action 'none';base-uri 'none'"><style>${css}</style><div id="root"></div><script>${js}</script>`;
await writeFile(resolve(out, 'standalone.html'), html);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setContent(
    '<iframe sandbox="allow-scripts" title="Independent exported React"></iframe>',
  );
  await page.locator('iframe').evaluate((frame, source) => {
    frame.srcdoc = source;
  }, html);
  await page
    .frameLocator('iframe')
    .getByRole('heading', { name: '保存したReactページ', exact: true })
    .waitFor();
  if (errors.length) throw Error(errors.join('\n'));
  await page.screenshot({ path: resolve(out, 'standalone.png') });
  process.stdout.write(
    'PASS: actual UI ZIP; strict TypeScript; independent React-only production bundle; opaque browser render; zero browser errors\n',
  );
} finally {
  await browser.close();
}
