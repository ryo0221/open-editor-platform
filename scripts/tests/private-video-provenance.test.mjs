import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateDigestOwners } from '../../packages/video-metadata/file-backed-storage/integration/provenance.mjs';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const [lock, video, playground] = await Promise.all([
  json('package-lock.json'),
  json('packages/video-metadata/package.json'),
  json('apps/playground/package.json'),
]);
test('normal runtime requires both exact workspace owners', () => {
  validateDigestOwners(lock, video, playground, 'normal-playground');
  for (const owner of ['video', 'video-lock', 'playground', 'playground-lock']) {
    const [l, v, p] = globalThis.structuredClone([lock, video, playground]);
    const target = {
      video: v,
      'video-lock': l.packages['packages/video-metadata'],
      playground: p,
      'playground-lock': l.packages['apps/playground'],
    }[owner];
    delete target[owner.startsWith('video') ? 'devDependencies' : 'dependencies']['@noble/hashes'];
    assert.throws(() => validateDigestOwners(l, v, p, 'normal-playground'), /pin mismatch/);
  }
});
test('runtime fallback and unknown owner cannot bypass development ownership', () => {
  const v = globalThis.structuredClone(video);
  v.dependencies['@noble/hashes'] = '1.8.0';
  assert.throws(
    () => validateDigestOwners(lock, v, playground, 'video-fixture'),
    /development pin/,
  );
  assert.throws(() => validateDigestOwners(lock, video, playground, 'other'), /Unknown/);
  const p = globalThis.structuredClone(playground);
  p.dependencies['@noble/hashes'] = '^1.8.0';
  assert.throws(() => validateDigestOwners(lock, video, p, 'normal-playground'), /runtime digest/);
});

test('M2 normal runtime retains both exact digest owners', () => {
  validateDigestOwners(lock, video, playground, 'normal-playground-m2');
  const p = globalThis.structuredClone(playground);
  delete p.dependencies['@noble/hashes'];
  assert.throws(
    () => validateDigestOwners(lock, video, p, 'normal-playground-m2'),
    /runtime digest/,
  );
});
