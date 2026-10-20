import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';

test('public Geo boundary catalog bundles and resolves pinned data in Node without views or network', async () => {
  const bundle = await build({
    stdin: {
      contents:
        "export { bundledGeoBackgrounds, defaultGeoBackgroundSettings, resolveGeoBackgrounds } from '@editor-platform/geo-core/backgrounds';",
      resolveDir: process.cwd(),
    },
    platform: 'node',
    format: 'esm',
    bundle: true,
    write: false,
    metafile: true,
  });
  assert.deepEqual(
    Object.keys(bundle.metafile.inputs).filter((path) =>
      /(?:^|\/)(?:react|react-dom|editor-ui|canvas-ui)(?:\/|$)|\.(?:tsx|css)$/.test(path),
    ),
    [],
  );
  const api = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const backgrounds = api.resolveGeoBackgrounds(
    api.defaultGeoBackgroundSettings().map((setting) => ({ ...setting, enabled: true })),
  );
  assert.deepEqual(backgrounds.diagnostics, []);
  assert.deepEqual(
    backgrounds.layers.map((layer) => layer.geometries.length),
    [177, 4596, 1742],
  );
  assert.deepEqual(
    backgrounds.layers.map((layer) => layer.setting.hash),
    api.bundledGeoBackgrounds.map((entry) => entry.hash),
  );
});
