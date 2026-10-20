import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { animationExportDigest, publishAnimationExport } from '../animation-export-directory.mjs';

test('Animation export identity covers CSS, generated manifests and handoff bytes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'animation-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging');
  await mkdir(path.join(staging, 'generated'), { recursive: true });
  for (const name of [
    'runtime.js',
    'runtime.css',
    'generated/manifest.json',
    'handoff.json',
    'index.html',
  ])
    await writeFile(path.join(staging, name), name);
  const original = await animationExportDigest(staging);
  for (const name of ['runtime.css', 'generated/manifest.json', 'handoff.json', 'index.html']) {
    await writeFile(path.join(staging, name), name + ' changed');
    assert.notEqual(await animationExportDigest(staging), original, name);
    await writeFile(path.join(staging, name), name);
  }
});

test('Animation exports reuse only identical complete trees and preserve conflicting destinations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'animation-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = async (name, css) => {
    const dir = path.join(root, name);
    await mkdir(dir);
    await writeFile(path.join(dir, 'runtime.js'), 'same JS');
    await writeFile(path.join(dir, 'runtime.css'), css);
    return dir;
  };
  const first = await publishAnimationExport(await stage('one', 'a'), root, 'source');
  const sameStage = await stage('two', 'a');
  assert.equal(await publishAnimationExport(sameStage, root, 'source'), first);
  await assert.rejects(access(sameStage));
  const changed = await publishAnimationExport(await stage('three', 'b'), root, 'source');
  assert.notEqual(changed, first);
  await writeFile(path.join(first, 'runtime.css'), 'tampered');
  const incoming = await stage('four', 'a');
  await assert.rejects(publishAnimationExport(incoming, root, 'source'), /differs/);
  assert.equal(await readFile(path.join(first, 'runtime.css'), 'utf8'), 'tampered');
  assert.equal(await readFile(path.join(incoming, 'runtime.css'), 'utf8'), 'a');
});
