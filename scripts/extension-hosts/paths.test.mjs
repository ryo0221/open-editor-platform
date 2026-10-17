import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertOutsideCheckout } from './paths.mjs';
test('outside guard resolves repo and rejects in-repo or symlink parent outputs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'extension-host-path-'));
  try {
    const repo = path.join(root, 'repo'),
      outside = path.join(root, 'outside');
    await mkdir(repo);
    await mkdir(outside);
    await mkdir(path.join(repo, 'nested'));
    await assert.rejects(
      assertOutsideCheckout(repo, path.join(repo, 'output')),
      /outside checkout/,
    );
    await assert.rejects(
      assertOutsideCheckout(repo, path.join(repo, 'nested', 'output')),
      /outside checkout/,
    );
    await symlink(repo, path.join(root, 'repo-link'));
    await assert.rejects(
      assertOutsideCheckout(repo, path.join(root, 'repo-link', 'output')),
      /symlink/,
    );
    await symlink(outside, path.join(root, 'outside-link'));
    await assert.rejects(
      assertOutsideCheckout(repo, path.join(root, 'outside-link', 'output')),
      /symlink/,
    );
    assert.equal(
      await assertOutsideCheckout(repo, path.join(outside, 'output')),
      path.join(outside, 'output'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
