import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// KR4 (docs/kind-registry-design.md, 「境界の確認」): a package's `./kind` is headless. Its whole
// import closure has no React and no .tsx module, so a Host loads it without any Surface code.
const root = fileURLToPath(new URL('../..', import.meta.url));
const kindPackages = readdirSync(join(root, 'packages'))
  .filter((dir) => existsSync(join(root, 'packages', dir, 'src', 'kind.ts')))
  .sort();

test('every kind definition is exported as ./kind', () => {
  assert.ok(kindPackages.length >= 25, `only ${kindPackages.length} kind definitions`);
  for (const dir of kindPackages) {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    assert.equal(manifest.exports?.['./kind'], './src/kind.ts', `${dir} exports ./kind`);
  }
});

for (const dir of kindPackages)
  test(`${dir}/kind imports no React`, async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [`packages/${dir}/src/kind.ts`],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.deepEqual(
      inputs.filter((file) => /node_modules\/react(-dom)?\//.test(file) || file.endsWith('.tsx')),
      [],
    );
  });
