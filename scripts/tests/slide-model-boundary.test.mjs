import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { build } from 'esbuild';

test('public Slide animation commands bundle for a headless Host without React views', async () => {
  const result = await build({
    stdin: {
      contents:
        "export { createDeck, placeSlideAnimation, replaceSlideAnimation } from '@editor-platform/slide/model';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
  });
  const viewDependencies = Object.keys(result.metafile.inputs).filter((name) =>
    /(?:^|\/)(?:react|react-dom|editor-ui|canvas-ui)(?:\/|$)|\.(?:tsx|css)$/.test(name),
  );
  assert.deepEqual(viewDependencies, []);
});
