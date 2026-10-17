import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createRegistry, createSample, addNode, patchNode } from '../src/model.mjs';
import { exportProject } from '../src/exporter.mjs';
test('exported frontend operates independently: purchase callback and controlled email submit', async () => {
  const rs = createRegistry();
  const inserted = addNode(
    createSample(),
    rs.find((r) => r.name === 'EmailInput'),
    'hero',
  );
  const doc = patchNode(inserted.doc, inserted.id, { binding: 'onSubscribe' });
  const files = exportProject(doc, rs);
  for (const [name, value] of Object.entries(files)) {
    await mkdir('test-output/frontend/' + name.split('/').slice(0, -1).join('/'), {
      recursive: true,
    });
    await writeFile('test-output/frontend/' + name, value);
  }
  await writeFile(
    'test-output/frontend/entry.jsx',
    `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SoraProductPage} from './SoraProductPage'; window.calls=[];createRoot(document.getElementById('root')).render(<SoraProductPage onBuy={()=>window.calls.push('buy')} onSubscribe={email=>window.calls.push(email)}/>);`,
  );
  const bundle = await build({
    entryPoints: ['test-output/frontend/entry.jsx'],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'https://frontend.example/',
    runScripts: 'dangerously',
  });
  dom.window.eval(bundle.outputFiles[0].text);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  await tick();
  const d = dom.window.document;
  d.querySelector('button').click();
  await tick();
  assert.equal(dom.window.calls[0], 'buy');
  const input = d.querySelector('input');
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(
    input,
    'hello@example.com',
  );
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  d.querySelector('form').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await tick();
  assert.equal(dom.window.calls[1], 'hello@example.com');
  assert.match(d.querySelector('form').textContent, /Thank you/);
  assert.equal(d.querySelector('iframe'), null);
  assert.equal(d.querySelector('[data-node]'), null);
  dom.window.close();
});
