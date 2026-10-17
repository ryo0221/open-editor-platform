import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pcmMode,
  pcmBuild,
  validatePcmManifest,
  PCM_CONSUMER,
  PCM_WASM_SHA,
} from '../extension-hosts/private-video-pcm-build.mjs';
test('normal M2 defaults to JS and requires an explicit valid forced mode', async () => {
  assert.equal(pcmMode('video-v2-review'), 'js');
  assert.equal(pcmMode('video-v2-review', 'wasm'), 'wasm');
  for (const mode of ['auto', '', 'WASM', null])
    assert.throws(() => pcmMode('video-v2-review', mode));
  assert.throws(() => pcmMode('video-v1-review', 'js'));
  assert.throws(() => pcmMode('video-v1-review', 'wasm'));
  assert.deepEqual(await pcmBuild('video-v1-review'), {});
  assert.equal((await pcmBuild('video-v2-review')).manifest.mode, 'js');
  await assert.rejects(pcmBuild('video-v2-review', 'wasm'), /verified kernel/);
});
test('PCM provenance refuses unreviewed mode, kernel, consumer and extra fields', () => {
  const js = { mode: 'js', consumer: PCM_CONSUMER };
  const wasm = {
    ...js,
    mode: 'wasm',
    wasmSha256: PCM_WASM_SHA,
    kernelManifestSha256: 'a'.repeat(64),
  };
  validatePcmManifest(js);
  validatePcmManifest(wasm);
  for (const value of [
    undefined,
    { ...js, mode: 'auto' },
    { ...js, consumer: 'other' },
    { ...js, fallback: true },
    { ...wasm, wasmSha256: 'b'.repeat(64) },
    { ...wasm, kernelManifestSha256: '' },
  ])
    assert.throws(() => validatePcmManifest(value));
});
