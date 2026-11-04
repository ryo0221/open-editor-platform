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

test('static CAD distribution requires the complete bundle independently of its checksum manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cad-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = await kernelDir(root, 'current', 'static-kernel');
  const current = { id: 'static', js: 'k.js', wasm: 'k.wasm', wasmSha256: sha('static-kernel') };
  const plugin = cadDevelopmentKernel(dir, '', { current, previous: [] });
  const emitted = [];
  const emit = { emitFile: (asset) => emitted.push(asset) };
  assert.throws(() => plugin.generateBundle.call(emit), /requires NOTICE/);

  // Independently enumerate bundle.sh's contract, not the implementation's list.
  const files = {
    'NOTICE.txt': 'license fixture',
    'source/occt-bb368e2.tar.gz': 'OCCT source archive fixture',
    'source/opencascade.js-src.tar.gz': 'generator source archive fixture',
    'source/emscripten-version.txt': 'toolchain fixture',
    'source/occt-commit.txt': 'OCCT commit fixture',
    'source/image.txt': 'image fixture',
    'source/editor-platform-cad-kernel/README.md': 'build instructions fixture',
    'source/editor-platform-cad-kernel/build.mjs': 'build profile fixture',
    'source/editor-platform-cad-kernel/build.sh': 'build script fixture',
    'source/editor-platform-cad-kernel/bundle.sh': 'bundle script fixture',
    'source/editor-platform-cad-kernel/opencascade.d0-leakcheck.yml': 'config fixture',
    'source/editor-platform-cad-kernel/patch-destructors.py': 'patch fixture',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  const manifest = (entries) =>
    entries.map(([name, content]) => `${sha(content)}  ${name}\n`).join('');
  const sums = path.join(dir, 'source/SHA256SUMS');
  const entries = Object.entries(files);

  // The review reproduction: NOTICE plus one arbitrary source file used to pass.
  await writeFile(sums, manifest(entries.filter(([name]) =>
    name === 'NOTICE.txt' || name === 'source/image.txt',
  )));
  assert.throws(() => plugin.generateBundle.call(emit), /incomplete corresponding source/);
  assert.equal(emitted.length, 0);

  // Omitted entries must fail even when all files exist and remaining hashes match.
  for (const [missing] of entries) {
    await writeFile(sums, manifest(entries.filter(([name]) => name !== missing)));
    assert.throws(
      () => plugin.generateBundle.call(emit),
      /incomplete corresponding source/,
      missing,
    );
    assert.equal(emitted.length, 0);
  }

  await writeFile(sums, manifest(entries));
  const expected = [
    'cad-kernel/kernel.js',
    'cad-kernel/kernel.wasm',
    'cad-kernel/source/SHA256SUMS',
    ...entries.map(([name]) => 'cad-kernel/' + name),
  ].sort();
  plugin.generateBundle.call(emit);
  assert.deepEqual(emitted.map((asset) => asset.fileName).sort(), expected);

  const retainedOnly = cadDevelopmentKernel('', dir, { current, previous: [current] });
  const oldAssets = [];
  retainedOnly.generateBundle.call({ emitFile: (asset) => oldAssets.push(asset) });
  assert.deepEqual(
    oldAssets.map((asset) => asset.fileName).sort(),
    expected.map((name) =>
      name.replace('cad-kernel/', `cad-kernel/${current.wasmSha256.slice(0, 12)}/`),
    ).sort(),
  );

  // A complete manifest does not make missing or tampered actual files acceptable.
  for (const [name, content] of entries) {
    await rm(path.join(dir, name));
    const invalidAssets = [];
    assert.throws(() =>
      plugin.generateBundle.call({ emitFile: (asset) => invalidAssets.push(asset) }),
    );
    assert.deepEqual(invalidAssets, []);
    await writeFile(path.join(dir, name), content);
  }
  await writeFile(path.join(dir, 'source/image.txt'), 'tampered');
  assert.throws(() => plugin.generateBundle.call(emit), /checksum mismatch/);
});
