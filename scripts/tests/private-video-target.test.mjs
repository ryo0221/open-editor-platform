import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { requirePrivateVideoTarget } from '../extension-hosts/private-video-target.mjs';
const v1 = 'apps/playground/src/private-video/runtime-entry.mjs';
const v2 = 'apps/playground/src/private-video-m2/runtime-entry.mjs';
async function fixture(entryPoint, imported, stdout = false) {
  return build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    metafile: true,
    ...(stdout ? {} : { outfile: '/tmp/private-video-target-fixture.js' }),
    plugins: [
      {
        name: 'synthetic-target-only',
        setup(api) {
          api.onResolve({ filter: /runtime-entry\.mjs$/ }, (args) => ({
            path: path.resolve(args.path),
          }));
          api.onLoad({ filter: /runtime-entry\.mjs$/ }, (args) => ({
            contents: `${args.path === path.resolve(entryPoint) && imported ? `import '${imported}';` : ''} console.log(${JSON.stringify(args.path)});`,
            loader: 'js',
          }));
        },
      },
    ],
  });
}
test('real esbuild metadata binds each exact synthetic entry to its emitted artifact', async () => {
  for (const [target, entry] of [
    ['video-v1-review', v1],
    ['video-v2-review', v2],
  ]) {
    const result = await fixture(entry);
    assert.deepEqual(requirePrivateVideoTarget(result, target), { target, entryPoint: entry });
    assert.throws(
      () =>
        requirePrivateVideoTarget(
          result,
          target === 'video-v1-review' ? 'video-v2-review' : 'video-v1-review',
        ),
      /target mismatch/,
    );
    assert.throws(() => requirePrivateVideoTarget(result, 'unknown'), /Unknown/);
    result.outputFiles[0].contents = new Uint8Array(1);
    assert.throws(() => requirePrivateVideoTarget(result, target), /target mismatch/);
  }
});
test('importing v1 into M2 cannot satisfy either target proof', async () => {
  const result = await fixture(v2, v1);
  assert.throws(() => requirePrivateVideoTarget(result, 'video-v2-review'), /Mixed/);
  assert.throws(() => requirePrivateVideoTarget(result, 'video-v1-review'), /target mismatch/);
});

test('single stdout artifact retains exact entry and positive output contribution checks', async () => {
  const result = await fixture(v2, undefined, true);
  assert.equal(result.outputFiles[0].path, '<stdout>');
  requirePrivateVideoTarget(result, 'video-v2-review');
  const metadata = Object.values(result.metafile.outputs)[0];
  delete metadata.inputs[v2].bytesInOutput;
  assert.throws(() => requirePrivateVideoTarget(result, 'video-v2-review'), /target mismatch/);
});
