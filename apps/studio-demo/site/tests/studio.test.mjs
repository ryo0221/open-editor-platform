import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { nativeResolver } from '../scripts/native-resolver.mjs';
import { compileSource } from '../src/compiler.mjs';
import { voiceSource } from '../src/voice-source.mjs';
await mkdir('test-output', { recursive: true });
await build({
  stdin: {
    contents: `export * from '@editor-platform/editor-core';export * from '@editor-platform/slide/model';export * from '@editor-platform/whiteboard/model';export * from './src/samples.ts';export * from './src/tasks-data.ts';export * from '@editor-platform/editor-host';export * from '@editor-platform/artifact-core';export * from '@editor-platform/structured-data/model';export * from '@editor-platform/reference-artifact-host/model';`,
    resolveDir: process.cwd(),
    sourcefile: 'native-model-entry.mjs',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [nativeResolver],
  outfile: 'test-output/native-models.mjs',
});
const native = await import('../test-output/native-models.mjs');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
test('native source provenance: every vendored file matches pinned GitHub blob SHA', async () => {
  const origin = JSON.parse(await readFile('vendor/editor-platform/origin.json', 'utf8'));
  assert.match(origin.repository, /^[\w.-]+\/[\w.-]+$/);
  if (process.env.REQUIRE_PINNED_SOURCE === '1' || origin.commit !== null)
    assert.match(origin.commit, /^[a-f0-9]{40}$/);
  for (const f of origin.files) {
    const data = await readFile(f.sitePath ?? 'vendor/editor-platform/' + f.path);
    const sha = createHash('sha1')
      .update('blob ' + data.length + '\0')
      .update(data)
      .digest('hex');
    assert.equal(sha, f.sha, f.path);
  }
});
test('native Slide: valid editable samples, command history, JSON roundtrip and SVG output', () => {
  const deck = native.soraDeck();
  assert.ok(native.isDeck(deck));
  assert.equal(deck.slides.length, 6);
  const session = new native.EditorSession(deck);
  const updated = session.execute(
    native.updateObject('sora-cover', 'cover-title', { text: 'SORAの次の企画' }),
  );
  assert.match(native.exportSlideSvg(updated, updated.slides[0]), /SORAの次の企画/);
  assert.equal(
    session.undo().slides[0].objects.find((o) => o.id === 'cover-title').text,
    'SORA Voice',
  );
  assert.equal(
    session.redo().slides[0].objects.find((o) => o.id === 'cover-title').text,
    'SORAの次の企画',
  );
  assert.ok(native.isDeck(JSON.parse(JSON.stringify(session.content))));
  session.execute(native.insertObject('sora-cover', 'text'));
  assert.equal(session.content.slides[0].objects.length, deck.slides[0].objects.length + 1);
  assert.ok(native.isDeck(session.content));
});
test('native Whiteboard: nine business blocks, editing, connection, Undo and SVG export', () => {
  const board = native.soraCanvas();
  assert.ok(native.isWhiteboard(board));
  assert.equal(board.sections.length, 9);
  const session = new native.EditorSession(board);
  session.execute(native.updateNode('note-value', { text: '新しい価値提案' }));
  session.execute(native.connectNodes('note-value', 'note-customers'));
  const saved = JSON.parse(JSON.stringify(session.content));
  assert.ok(native.isWhiteboard(saved));
  assert.equal(saved.connectors.length, 1);
  assert.match(native.exportWhiteboardSvg(saved), /新しい価値提案/);
  session.undo();
  assert.equal(session.content.connectors.length, 0);
  session.undo();
  assert.equal(
    session.content.nodes.find((n) => n.id === 'note-value').text,
    board.nodes.find((n) => n.id === 'note-value').text,
  );
});
function environment() {
  const errors = [],
    console = new VirtualConsole();
  console.on('jsdomError', (e) => errors.push(e.message));
  console.on('error', (e) => errors.push(String(e)));
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'https://example.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: console,
  });
  const w = dom.window;
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.structuredClone = structuredClone;
  w.setImmediate = setImmediate;
  w.clearImmediate = clearImmediate;
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540 };
  };
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  const downloads = [];
  w.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download);
  };
  return { dom, w, d: w.document, errors, downloads };
}
const setValue = (w, el, value) => {
  Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype,
    'value',
  ).set.call(el, value);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
};
test('public Host lifecycle: save/reopen and separate native Session histories', async () => {
  const saved = new Map();
  const storage = {
    put: async (a) => saved.set(a.id, structuredClone(a)),
    get: async (id) => saved.get(id),
    list: async () => [...saved.values()],
    remove: async (id) => saved.delete(id),
  };
  const a = native.createArtifact('slide', 'SORA', native.soraDeck()),
    b = native.createArtifact('slide', 'Copy', native.soraDeck());
  const first = new native.ArtifactEditor(a, native.hostAdapters.slide, storage),
    second = new native.ArtifactEditor(b, native.hostAdapters.slide, storage);
  first.execute(native.updateObject('sora-cover', 'cover-title', { text: '保存した本文' }));
  assert.equal(second.snapshot.canUndo, false);
  await first.save({ commitVersion: true, author: 'reference Host' });
  assert.equal(first.snapshot.canUndo, true);
  const reopened = new native.ArtifactEditor(
    await storage.get(a.id),
    native.hostAdapters.slide,
    storage,
  );
  assert.match(JSON.stringify(reopened.snapshot.content), /保存した本文/);
  assert.equal(reopened.snapshot.canUndo, false);
  first.undo();
  assert.match(JSON.stringify(first.snapshot.content), /SORA Voice/);
  first.redo();
  assert.match(JSON.stringify(first.snapshot.content), /保存した本文/);
});
test('Kanban migration preserves record IDs and shares Grid native commands/history', () => {
  const old = native.soraTasks(),
    data = native.migrateTasks(old);
  assert.deepEqual(
    data.rows.map((r) => r.id),
    old.map((t) => t.id),
  );
  assert.deepEqual(
    data.rows.map((r) => r.values),
    old.map((task) => {
      const values = { ...task };
      delete values.id;
      return values;
    }),
  );
  assert.deepEqual(
    data.views.map((v) => v.projection),
    ['Kanban', 'Grid'],
  );
  assert.ok(native.isStructuredData(data));
  assert.throws(() => native.migrateTasks([{ ...old[0], status: 'invalid' }]));
});
test('Code: editable voice sample actually executes, sample transcript, typing and microphone bridge', async () => {
  const { dom, w, d, errors } = environment();
  d.body.innerHTML = '<div id="code-root"></div>';
  const messages = [];
  w.addEventListener('message', (e) => {
    if (e.data?.channel === 'ep-code-preview') messages.push(e.data);
  });
  w.eval(await readFile('dist/assets/code-preview.js', 'utf8'));
  const compiled = compileSource(voiceSource, 'SoraVoice.tsx');
  assert.ok(compiled.hasDefault);
  w.dispatchEvent(
    new w.MessageEvent('message', {
      source: w.parent,
      data: {
        channel: 'ep-code-host',
        type: 'render',
        token: 'test-voice',
        code: compiled.code,
        generation: 1,
      },
    }),
  );
  await tick();
  assert.match(d.querySelector('h1').textContent, /話す/);
  [...d.querySelectorAll('button')].find((b) => b.textContent.includes('サンプル再生')).click();
  await tick(1300);
  assert.match(d.querySelector('textarea').value, /5人/);
  assert.ok(messages.some((m) => m.type === 'transcript' && /5人/.test(m.text)));
  setValue(w, d.querySelector('textarea'), '編集した議事録');
  await tick();
  assert.ok(messages.some((m) => m.type === 'transcript' && m.text === '編集した議事録'));
  [...d.querySelectorAll('button')].find((b) => b.textContent.includes('マイクで入力')).click();
  await tick();
  assert.ok(messages.some((m) => m.type === 'request-microphone'));
  w.dispatchEvent(
    new w.MessageEvent('message', {
      source: w.parent,
      data: {
        channel: 'ep-code-host',
        type: 'speech',
        token: 'test-voice',
        generation: 1,
        event: 'start',
      },
    }),
  );
  w.dispatchEvent(
    new w.MessageEvent('message', {
      source: w.parent,
      data: {
        channel: 'ep-code-host',
        type: 'speech',
        token: 'test-voice',
        generation: 1,
        event: 'result',
        results: [{ text: '実際の認識結果', confidence: 1, final: true }],
      },
    }),
  );
  await tick();
  assert.match(d.querySelector('textarea').value, /実際の認識結果/);
  assert.ok(messages.some((m) => m.type === 'transcript' && /実際の認識結果/.test(m.text)));
  assert.deepEqual(errors, []);
  dom.window.close();
});
test('Code output: independent React component production bundle and sandbox network restrictions', async () => {
  await writeFile('test-output/SoraVoice.tsx', voiceSource);
  await writeFile(
    'test-output/voice-tsconfig.json',
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
      include: ['SoraVoice.tsx'],
    }),
  );
  execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'test-output/voice-tsconfig.json'],
    { stdio: 'pipe' },
  );
  const output = await build({
    entryPoints: ['test-output/SoraVoice.tsx'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['react'],
  });
  assert.ok(output.outputFiles[0].text.includes('webkitSpeechRecognition'));
  const html = await readFile('dist/code-preview.html', 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.equal(new JSDOM(html).window.document.querySelector('script[src]'), null);
  assert.throws(
    () => compileSource(voiceSource.replace("from 'react'", "from 'external-package'")),
    /reactのみ対応/,
  );
});
test('Code Host accepts a local default export specifier and preserves external import rejection', () => {
  const source = 'function App() { return <p>default specifier</p>; } export { App as default };';
  assert.equal(compileSource(source).hasDefault, true);
  assert.match(compileSource(source).code, /exports\.default/);
  assert.throws(() => compileSource('export { App as default } from "remote";'), /再export/);
});

test('Code preview ignores stale or unversioned speech while current speech still reaches the new component', async () => {
  const { dom, w, d, errors } = environment();
  d.body.innerHTML = '<div id="code-root"></div>';
  w.eval(await readFile('dist/assets/code-preview.js', 'utf8'));
  const code = compileSource(voiceSource).code;
  const message = (data) =>
    w.dispatchEvent(
      new w.MessageEvent('message', {
        source: w.parent,
        data: { channel: 'ep-code-host', token: 'speech-fixture', ...data },
      }),
    );
  for (const generation of [1, 2]) {
    message({ type: 'render', code, generation });
    await tick();
    [...d.querySelectorAll('button')].find((b) => b.textContent.includes('マイクで入力')).click();
    await tick();
  }
  const result = {
    type: 'speech',
    event: 'result',
    results: [{ text: 'stale', confidence: 1, final: true }],
  };
  message({ ...result, generation: 1 });
  message(result);
  await tick();
  assert.equal(d.querySelector('textarea').value, '');
  message({ ...result, generation: 2, results: [{ text: 'current', confidence: 1, final: true }] });
  await tick();
  assert.equal(d.querySelector('textarea').value, 'current');
  assert.deepEqual(errors, []);
  dom.window.close();
});
