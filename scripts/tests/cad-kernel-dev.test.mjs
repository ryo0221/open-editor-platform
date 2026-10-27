import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cadDevelopmentKernel } from '../dev/cad-kernel.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function kernelDir(root, name, bytes) {
  const dir = path.join(root, name);
  await mkdir(dir);
  await writeFile(path.join(dir, 'k.js'), 'export default () => {};');
  await writeFile(path.join(dir, 'k.wasm'), bytes);
  return dir;
}
const virtual = (plugin) => {
  const source = plugin.load('\0virtual:cad-kernel-build');
  const kernels = JSON.parse(source.split('export const kernels = ')[1].replace(/;$/, ''));
  const build = JSON.parse(source.split('export default ')[1].split(';\n')[0]);
  return { build, kernels };
};

test('CAD dev kernel: retained earlier builds and approved substitutes come only from build.mjs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cad-kernel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = await kernelDir(root, 'now', 'current');
  const old = await kernelDir(root, 'old', 'earlier');
  const spec = (id, bytes, extra = {}) => ({
    id,
    js: 'k.js',
    wasm: 'k.wasm',
    wasmSha256: sha(bytes),
    ...extra,
  });
  const current = spec('now', 'current');
  const previous = [
    spec('old', 'earlier', { substitute: true }),
    spec('bad', 'withdrawn', { substitute: true, revoked: true }),
  ];

  const { build, kernels } = virtual(cadDevelopmentKernel(now, old, { current, previous }));
  assert.equal(build.buildHash, `sha256:${sha('current')}`);
  assert.equal(kernels.retained.length, 1);
  assert.equal(kernels.retained[0].buildHash, `sha256:${sha('earlier')}`);
  assert.match(kernels.retained[0].wasmUrl, /^\/cad-kernel\/[0-9a-f]{12}\/kernel\.wasm$/);
  assert.deepEqual(kernels.revoked, [`sha256:${sha('withdrawn')}`]);
  assert.deepEqual(kernels.substitutes, [
    { from: `sha256:${sha('earlier')}`, to: build.buildHash, semanticsVersion: 2 },
  ]);

  // A directory whose Wasm is not a listed earlier build is refused, not served.
  const stranger = await kernelDir(root, 'stranger', 'unknown');
  assert.throws(
    () => cadDevelopmentKernel(now, stranger, { current, previous }),
    /not an earlier build/,
  );
  // Without a current build nothing is substituted. Empty strings, not undefined, so that the
  // caller's CAD_OCCT_DIST and CAD_OCCT_RETAINED do not apply.
  const none = virtual(cadDevelopmentKernel('', '', { current, previous }));
  assert.equal(none.build, null);
  assert.deepEqual(none.kernels.substitutes, []);
});
