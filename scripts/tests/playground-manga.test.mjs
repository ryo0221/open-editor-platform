import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { build } from 'vite';
import { playgroundMangaSample } from '../dev/playground-manga.mjs';

test('normal build excludes sample JS and CSS even without tree shaking; explicit opt-in includes both', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'playground-manga-build-'));
  const previous = process.env.VITE_MANGA_EXPERIMENT;
  delete process.env.VITE_MANGA_EXPERIMENT;
  t.after(async () => {
    if (previous === undefined) delete process.env.VITE_MANGA_EXPERIMENT;
    else process.env.VITE_MANGA_EXPERIMENT = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'entry.js'),
    "import { MangaArtTools } from 'virtual:playground-manga-tools'; globalThis.tool = MangaArtTools;",
  );
  await writeFile(
    path.join(root, 'sample.js'),
    "import './sample.css'; globalThis.MANGA_SAMPLE_SENTINEL = true; export const LayeredArtTools = () => null;",
  );
  await writeFile(path.join(root, 'sample.css'), '.MANGA_SAMPLE_SENTINEL { color: red; }');

  for (const flag of [undefined, '0', '1']) {
    const env = path.join(root, '.env.test');
    if (flag === undefined) await rm(env, { force: true });
    else await writeFile(env, 'VITE_MANGA_EXPERIMENT=' + flag);
    const result = await build({
      configFile: false,
      root,
      mode: 'test',
      logLevel: 'silent',
      plugins: [playgroundMangaSample(path.join(root, 'sample.js'))],
      build: {
        write: false,
        minify: false,
        cssMinify: false,
        rollupOptions: { input: path.join(root, 'entry.js'), treeshake: false },
      },
    });
    const output = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
    const javascript = output.filter((item) => item.type === 'chunk').map((item) => item.code).join('');
    const css = output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'));
    assert.equal(javascript.includes('MANGA_SAMPLE_SENTINEL'), flag === '1', String(flag));
    assert.equal(css.length > 0, flag === '1', String(flag));
  }
});
