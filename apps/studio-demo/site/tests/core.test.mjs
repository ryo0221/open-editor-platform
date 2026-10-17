import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import {
  createRegistry,
  createSample,
  addNode,
  findNode,
  patchNode,
  moveNode,
  duplicateNode,
  removeNode,
  validate,
} from '../src/model.mjs';
import { compileSource, importComponent } from '../src/compiler.mjs';
import { demoSource } from '../src/components-source.mjs';
import { exportProject } from '../src/exporter.mjs';
const registry = createRegistry();
const sample = createSample();
await mkdir('test-output', { recursive: true });
await build({
  entryPoints: ['src/preview.jsx'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'test-output/preview.mjs',
  external: ['react', 'react-dom/client'],
});
const { Page, loadComponents } = await import('../test-output/preview.mjs');
const compiled = registry.map((r) => ({
  ...r,
  compiled: compileSource(r.source, r.filename).code,
}));
test('sample schema and original React implementations resolve', () => {
  assert.deepEqual(validate(sample, registry), []);
  const components = loadComponents(compiled);
  for (const r of registry) assert.equal(typeof components[r.id], 'function');
  const html = renderToStaticMarkup(
    React.createElement(Page, { doc: sample, registry: compiled, components, mode: 'preview' }),
  );
  assert.match(html, /Less noise/);
  assert.match(html, /wireless speaker, silver/);
  assert.match(html, /Explore SORA One/);
});
test('import: TSX annotations, typed defaults, named/default exports, diagnostics', () => {
  const r = importComponent(demoSource);
  assert.equal(r.name, 'PromoCard');
  assert.equal(r.props.tone.default, 'dark');
  assert.equal(typeof loadComponents([r])[r.id], 'function');
  const ts = demoSource
    .replace('export function PromoCard({', 'export default function PromoCard({')
    .replace('"name":"PromoCard"', '"name":"PromoCard","export":"default"');
  assert.equal(importComponent(ts).isDefault, true);
  assert.throws(
    () =>
      importComponent(
        demoSource.replace('import React from "react"', 'import React from "unsupported-package"'),
      ),
    /reactのみ対応/,
  );
  assert.throws(() => importComponent('export const Card=()=>null'), /登録情報/);
  assert.throws(
    () =>
      importComponent(demoSource.replace('export function PromoCard', 'export function Missing')),
    /exportが見つかりません/,
  );
  assert.throws(
    () => importComponent(demoSource.replace('"default":"dark"', '"default":"pink"')),
    /enum/,
  );
});
test('composition: insert, props, nesting, ordering, duplicate, deletion and validation', () => {
  const r = importComponent(demoSource);
  let out = addNode(sample, r, 'hero');
  let doc = out.doc;
  assert.equal(findNode(doc, out.id).props.title, 'Sound. Without limits.');
  doc = patchNode(doc, out.id, {
    props: { ...findNode(doc, out.id).props, title: 'My own React component' },
  });
  doc = moveNode(doc, out.id, 'actions', 0);
  assert.equal(findNode(doc, 'actions').children[0].id, out.id);
  assert.throws(() => moveNode(doc, 'hero', 'actions'), /子孫/);
  const dupe = duplicateNode(doc, out.id);
  assert.notEqual(dupe.id, out.id);
  assert.deepEqual(validate(dupe.doc, [...registry, r]), []);
  doc = removeNode(dupe.doc, out.id);
  assert.equal(findNode(doc, out.id), undefined);
  assert.ok(findNode(doc, dupe.id));
  const bad = patchNode(doc, dupe.id, {
    props: { ...findNode(doc, dupe.id).props, tone: 'invalid' },
  });
  assert.throws(() => exportProject(bad, [...registry, r]), /未対応の値/);
  assert.deepEqual(validate(sample, registry), []);
});
test('export: original source, deterministic imports, JSON round trip and injection escaping', () => {
  const r = importComponent(demoSource);
  const added = addNode(sample, r, 'hero');
  const title = '</script><img src=x onerror=alert(1)> {"x"}\\\n';
  const doc = patchNode(added.doc, added.id, {
    props: { ...findNode(added.doc, added.id).props, title },
  });
  const files = exportProject(doc, [...registry, r]);
  assert.match(
    files['SoraProductPage.tsx'],
    /import \{ PromoCard \} from "\.\/components\/PromoCard"/,
  );
  assert.equal(files['components/PromoCard.tsx'], demoSource);
  assert.equal(files['components/SoraUI.jsx'], registry[0].source);
  assert.ok(files['SoraProductPage.tsx'].includes('title={' + JSON.stringify(title) + '}'));
  assert.equal(files['SoraProductPage.tsx'].includes('data-node'), false);
  assert.equal(files['SoraProductPage.tsx'].includes('ep-host'), false);
  assert.deepEqual(exportProject(doc, [...registry, r]), files);
  const loaded = JSON.parse(files['composition.json']);
  assert.deepEqual(loaded.doc, doc);
  assert.deepEqual(validate(loaded.doc, loaded.registry), []);
});
test('exported frontend: independent TypeScript check, production bundle and rendering parity', async () => {
  const r = importComponent(demoSource);
  let { doc } = addNode(sample, r, 'hero');
  const added = addNode(
    doc,
    registry.find((x) => x.name === 'EmailInput'),
    'hero',
  );
  doc = patchNode(added.doc, added.id, { binding: 'onSubscribe' });
  const rs = [...registry, r];
  const files = exportProject(doc, rs);
  for (const [name, contents] of Object.entries(files)) {
    await mkdir('test-output/export/' + name.split('/').slice(0, -1).join('/'), {
      recursive: true,
    });
    await writeFile('test-output/export/' + name, contents);
  }
  await writeFile(
    'test-output/export/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        jsx: 'react-jsx',
        allowJs: true,
        checkJs: false,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['**/*.tsx', '**/*.jsx'],
    }),
  );
  execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'test-output/export/tsconfig.json'],
    { stdio: 'pipe' },
  );
  await build({
    entryPoints: ['test-output/export/SoraProductPage.tsx'],
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    outfile: 'test-output/standalone.mjs',
    external: ['react'],
    loader: { '.css': 'empty' },
  });
  const { SoraProductPage } = await import('../test-output/standalone.mjs');
  const html = renderToStaticMarkup(React.createElement(SoraProductPage, {}));
  const full = rs.map((x) => ({ ...x, compiled: compileSource(x.source, x.filename).code }));
  const before = renderToStaticMarkup(
    React.createElement(Page, {
      doc,
      registry: full,
      components: loadComponents(full),
      mode: 'preview',
    }),
  );
  assert.equal(html, before.replace(/ data-node="[^"]*"/g, ''));
  assert.match(html, /type="email"/);
  assert.match(html, /Sound. Without limits/);
  assert.equal(html.includes('data-node'), false);
});
test('sandbox contracts: opaque origin, blocked network, no imported-code evaluation in editor', async () => {
  const html = await readFile('dist/preview.html', 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  const app = await readFile('src/app.jsx', 'utf8');
  assert.match(app, /sandbox="allow-scripts"/);
  assert.equal(app.includes('allow-same-origin'), false);
  assert.equal(app.includes('new Function'), false);
  assert.match(app, /e\.source!==iframe\.current\?\.contentWindow/);
  assert.match(app, /d\.token!==token\.current/);
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
test('actual React preview interactions: nested selection, button callback and email input', async () => {
  await build({
    entryPoints: ['src/preview.jsx'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: 'test-output/preview-browser.js',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const dom = new JSDOM('<div id="preview-root"></div>', {
    url: 'https://example.test/preview.html',
    runScripts: 'dangerously',
  });
  dom.window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const events = [];
  dom.window.addEventListener('message', (e) => {
    if (e.data?.channel === 'ep-preview') events.push(e.data);
  });
  dom.window.eval(await readFile('test-output/preview-browser.js', 'utf8'));
  function send(doc, mode) {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        source: dom.window.parent,
        data: {
          channel: 'ep-host',
          type: 'render',
          token: 'test-token',
          doc,
          registry: compiled,
          selected: 'headline',
          mode,
        },
      }),
    );
  }
  send(sample, 'edit');
  await tick();
  dom.window.document.querySelector('h1').click();
  await tick();
  assert.equal(events.find((x) => x.type === 'select')?.id, 'headline');
  assert.equal(
    events.some((x) => x.type === 'event'),
    false,
  );
  send(sample, 'preview');
  await tick();
  dom.window.document.querySelector('button').click();
  await tick();
  assert.equal(events.find((x) => x.type === 'event')?.event.binding, 'onBuy');
  let { doc, id } = addNode(
    sample,
    registry.find((x) => x.name === 'EmailInput'),
    'hero',
  );
  doc = patchNode(doc, id, { binding: 'onSubscribe' });
  send(doc, 'preview');
  await tick();
  const input = dom.window.document.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(input, 'ryo@example.com');
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  const form = dom.window.document.querySelector('form');
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(events.filter((x) => x.type === 'event').at(-1)?.event.value, 'ryo@example.com');
  assert.match(form.textContent, /Thank you/);
  dom.window.close();
});
test('archived prototype UI flow: import, add, edit prop, move, undo/redo, export and reload', async () => {
  await build({
    stdin: {
      contents:
        "import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './src/app.jsx';createRoot(document.getElementById('root')).render(React.createElement(App));",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: 'test-output/legacy-app.js',
    define: {
      'process.env.NODE_ENV': '"production"',
      __PREVIEW_DOCUMENT__: JSON.stringify(await readFile('dist/preview.html', 'utf8')),
    },
  });
  const bundle = await readFile('test-output/legacy-app.js', 'utf8');
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'https://example.test/',
    runScripts: 'dangerously',
  });
  dom.window.ResizeObserver = class {
    constructor(fn) {
      this.fn = fn;
    }
    observe() {
      this.fn([{ contentRect: { width: 950 } }]);
    }
    disconnect() {}
  };
  dom.window.URL.createObjectURL = () => 'blob:test';
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {};
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.localStorage.setItem('ep-studio-active', 'react');
  dom.window.eval(bundle.replace(/import\.meta\.url/g, 'window.location.href'));
  await tick();
  const d = dom.window.document;
  const button = (text) =>
    [...d.querySelectorAll('button')].find((x) => x.textContent.includes(text));
  button('React Componentを取り込む').click();
  await tick();
  button('部品として取り込む').click();
  await tick();
  d.querySelector('[aria-label="PromoCardを追加"]').click();
  await tick();
  assert.equal(d.querySelector('[aria-label="prop title"]').value, 'Sound. Without limits.');
  const area = d.querySelector('[aria-label="prop title"]');
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(
    area,
    'My custom headline',
  );
  area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  let saved = JSON.parse(dom.window.localStorage.getItem('ep-react-studio-v1'));
  const customId = findNode(saved.doc, 'hero').children.at(-1).id;
  assert.equal(findNode(saved.doc, customId).props.title, 'My custom headline');
  d.querySelector('[aria-label="部品の親を変更"]').value = 'actions';
  d.querySelector('[aria-label="部品の親を変更"]').dispatchEvent(
    new dom.window.Event('change', { bubbles: true }),
  );
  await tick();
  saved = JSON.parse(dom.window.localStorage.getItem('ep-react-studio-v1'));
  assert.equal(findNode(saved.doc, 'actions').children.at(-1).id, customId);
  d.querySelector('[aria-label="元に戻す"]').click();
  await tick();
  saved = JSON.parse(dom.window.localStorage.getItem('ep-react-studio-v1'));
  assert.equal(findNode(saved.doc, 'hero').children.at(-1).id, customId);
  d.querySelector('[aria-label="やり直す"]').click();
  await tick();
  button('Reactを書き出す').click();
  await tick();
  assert.match(d.querySelector('.export-code').textContent, /import \{ PromoCard \}/);
  assert.match(d.querySelector('.export-code').textContent, /My custom headline/);
  d.querySelector('[aria-label="閉じる"]').click();
  await tick();
  d.querySelector('[aria-label="モバイル幅"]').click();
  await tick();
  assert.match(d.querySelector('.devices').textContent, /390px/);
  button('プレビュー').click();
  await tick();
  assert.match(d.querySelector('.canvas-foot').textContent, /インタラクティブプレビュー/);
  assert.deepEqual(
    validate(
      JSON.parse(dom.window.localStorage.getItem('ep-react-studio-v1')).doc,
      JSON.parse(dom.window.localStorage.getItem('ep-react-studio-v1')).registry,
    ),
    [],
  );
  dom.window.close();
});
