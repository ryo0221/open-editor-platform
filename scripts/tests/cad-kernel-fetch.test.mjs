/* global Response */
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cadKernelReleaseFiles,
  cadKernelReleaseTag,
  cadKernelSpec,
  fetchCadKernel,
} from '../cad-kernel/fetch.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const spec = {
  id: 'k',
  js: 'k.js',
  wasm: 'k.wasm',
  wasmSha256: sha('wasm'),
  jsSha256: sha('export default () => {};'),
};

/**
 * A release as fetch.mjs reads it: asset name → bytes, served by a fake fetch. `listed` replaces
 * assets before SHA256SUMS is written, `overrides` after it.
 */
async function release(root, overrides = {}, listed = {}) {
  const src = path.join(root, 'bundle');
  await mkdir(path.join(src, 'source'), { recursive: true });
  await writeFile(path.join(src, 'source', 'occt.txt'), 'occt');
  await writeFile(
    path.join(src, 'source', 'SHA256SUMS'),
    `${sha('notice')}  NOTICE.txt\n${sha('occt')}  source/occt.txt\n`,
  );
  const f = cadKernelReleaseFiles(spec);
  const assets = {
    [f.js]: Buffer.from('export default () => {};'),
    [f.wasm]: Buffer.from('wasm'),
    [f.types]: Buffer.from('export {};'),
    [f.notice]: Buffer.from('notice'),
    [f.source]: execFileSync('tar', ['-C', src, '-cf', '-', 'source']),
    ...listed,
  };
  assets[f.sums] = Buffer.from(
    Object.entries(assets)
      .map(([name, bytes]) => `${sha(bytes)}  ${name}\n`)
      .join(''),
  );
  Object.assign(assets, overrides);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const name = url.split('/').pop();
    return assets[name] ? new Response(assets[name]) : new Response('missing', { status: 404 });
  };
  return { fetchImpl, requested };
}

test('CAD kernel fetch: writes a release only when every file matches build.mjs and SHA256SUMS', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cad-kernel-fetch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = path.join(root, 'out');

  const ok = await release(root);
  await fetchCadKernel(out, spec, {
    source: true,
    baseUrl: 'https://mirror.test/dl',
    fetchImpl: ok.fetchImpl,
  });
  assert.equal(ok.requested[0], `https://mirror.test/dl/${cadKernelReleaseTag(spec)}/SHA256SUMS`);
  assert.match(cadKernelReleaseTag(spec), /^cad-kernel-[0-9a-f]{12}$/);
  assert.equal(await readFile(path.join(out, 'k.wasm'), 'utf8'), 'wasm');
  assert.equal(await readFile(path.join(out, 'source', 'occt.txt'), 'utf8'), 'occt');
  assert.deepEqual((await readdir(out)).sort(), [
    'NOTICE.txt',
    'k.d.ts',
    'k.js',
    'k.wasm',
    'source',
  ]);

  // A Wasm or loader that differs from build.mjs is refused even when SHA256SUMS lists it.
  const tampered = path.join(root, 'tampered');
  for (const [name, bytes] of [
    ['k.wasm', 'other wasm'],
    ['k.js', 'other loader'],
  ]) {
    const { fetchImpl } = await release(root, { [name]: Buffer.from(bytes) });
    await assert.rejects(
      fetchCadKernel(tampered, spec, { baseUrl: 'https://mirror.test/dl', fetchImpl }),
      new RegExp(`${name}: SHA-256 [0-9a-f]{64} differs`),
    );
  }
  // So is a notice that does not match the release's checksums.
  const notice = await release(root, { 'NOTICE.txt': Buffer.from('edited') });
  await assert.rejects(
    fetchCadKernel(tampered, spec, {
      baseUrl: 'https://mirror.test/dl',
      fetchImpl: notice.fetchImpl,
    }),
    /NOTICE\.txt: SHA-256/,
  );
  await assert.rejects(readdir(tampered), { code: 'ENOENT' });

  // A source tar that SHA256SUMS lists but whose own checksums fail keeps the installed source.
  const badSrc = path.join(root, 'bad-source');
  await mkdir(path.join(badSrc, 'source'), { recursive: true });
  await writeFile(path.join(badSrc, 'source', 'occt.txt'), 'changed');
  await writeFile(path.join(badSrc, 'source', 'SHA256SUMS'), `${sha('occt')}  source/occt.txt\n`);
  const bad = await release(
    root,
    {},
    { 'cad-kernel-source.tar': execFileSync('tar', ['-C', badSrc, '-cf', '-', 'source']) },
  );
  await assert.rejects(
    fetchCadKernel(out, spec, {
      source: true,
      baseUrl: 'https://mirror.test/dl',
      fetchImpl: bad.fetchImpl,
    }),
    /sha256sum/,
  );
  assert.equal(await readFile(path.join(out, 'source', 'occt.txt'), 'utf8'), 'occt');
  assert.deepEqual((await readdir(out)).sort(), [
    'NOTICE.txt',
    'k.d.ts',
    'k.js',
    'k.wasm',
    'source',
  ]);

  // Members outside source/, such as a loader that would replace the checked one, and links are
  // refused even when the tar itself matches SHA256SUMS.
  const evil = path.join(root, 'evil');
  await mkdir(path.join(evil, 'source'), { recursive: true });
  await writeFile(path.join(evil, 'k.js'), 'replaced loader');
  await symlink('/etc/hostname', path.join(evil, 'source', 'link'));
  const rootLink = path.join(root, 'root-link');
  await mkdir(rootLink);
  await symlink(path.join(out, 'source'), path.join(rootLink, 'source'));
  for (const [dir, members, message] of [
    [evil, ['k.js', 'source'], /member outside source/],
    [evil, ['source'], /link is not a plain file/],
    [rootLink, ['source'], /no single source\/ directory/],
  ]) {
    const { fetchImpl } = await release(
      root,
      {},
      { 'cad-kernel-source.tar': execFileSync('tar', ['-C', dir, '-cf', '-', ...members]) },
    );
    await assert.rejects(
      fetchCadKernel(out, spec, { source: true, baseUrl: 'https://mirror.test/dl', fetchImpl }),
      message,
    );
  }
  assert.equal(await readFile(path.join(out, 'k.js'), 'utf8'), 'export default () => {};');
  assert.equal(await readFile(path.join(out, 'source', 'occt.txt'), 'utf8'), 'occt');

  // A build without a recorded loader hash is not fetched.
  await assert.rejects(
    fetchCadKernel(tampered, { ...spec, jsSha256: undefined }, { fetchImpl: ok.fetchImpl }),
    /no jsSha256/,
  );
});

test('CAD kernel fetch: --build selects one build.mjs entry by its Wasm hash prefix', () => {
  const current = { ...spec, wasmSha256: 'aa11' + '0'.repeat(60) };
  const previous = [
    { ...spec, wasmSha256: 'bb22' + '0'.repeat(60) },
    { ...spec, wasmSha256: 'bb23' + '0'.repeat(60) },
  ];
  assert.equal(cadKernelSpec(undefined, { current, previous }), current);
  assert.equal(cadKernelSpec('BB22', { current, previous }), previous[0]);
  assert.throws(() => cadKernelSpec('bb2', { current, previous }), /ambiguous/);
  assert.throws(() => cadKernelSpec('cc', { current, previous }), /not a build/);
});
