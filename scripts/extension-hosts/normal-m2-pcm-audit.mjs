/** Validation-only audit of the normal Host's actual PCM consumer. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { verifyPreview } from '../../packages/video-core/experiments/pcm-wasm-m2/preview-oracle.mjs';
import { PCM_WASM_SHA } from './private-video-pcm-build.mjs';
export async function auditPlayback(page, content, files, mode) {
  assert(['js', 'wasm'].includes(mode));
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  await click('Play');
  await expect(page.locator('#playback')).toHaveText('Playback: playing', { timeout: 180000 });
  await click('Stop media');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 180000,
  });
  const stopped = await page.evaluate(() => globalThis.privatePcmDiagnostics());
  assert.equal(stopped.realmBytes, stopped.moduleBytes);
  await click('Play');
  await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 180000 });
  const playback = JSON.parse(await page.locator('#playback-debug').textContent());
  assert(playback.frames.length > 0);
  const preview = await page.evaluate(() => globalThis.privatePreview);
  const previewOracle = verifyPreview(content, files, preview);
  // Cancel after the first real encoder invocation, then retry through the same Host.
  await page.getByRole('button', { name: 'Stop media', exact: true }).evaluate((stop) => {
    globalThis.privateNativeEncoder = globalThis.VideoEncoder;
    globalThis.privateCancelledFrames = 0;
    globalThis.VideoEncoder = class extends globalThis.privateNativeEncoder {
      encode(...args) {
        super.encode(...args);
        globalThis.privateCancelledFrames++;
        stop.click();
      }
    };
  });
  let downloads = 0;
  const onDownload = () => downloads++;
  page.on('download', onDownload);
  await click('Export MP4');
  await expect
    .poll(() => page.evaluate(() => globalThis.privateCancelledFrames), { timeout: 180000 })
    .toBe(1);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 180000,
  });
  page.off('download', onDownload);
  assert.equal(downloads, 0);
  const cancelled = await page.evaluate(() => {
    globalThis.VideoEncoder = globalThis.privateNativeEncoder;
    return globalThis.privatePcmDiagnostics();
  });
  assert.equal(cancelled.realmBytes, cancelled.moduleBytes);
  assert.deepEqual(JSON.parse(await page.locator('#native').textContent()), content);
  return { mode, native: content, stopped, cancelled, playback, previewOracle };
}
export async function auditExport(page, audit) {
  const encoded = await page.evaluate(() => globalThis.privateLastExport);
  const backend = await page.evaluate(() => globalThis.privatePcmDiagnostics());
  assert.deepEqual(
    audit.playback.chunks.map((x) => [x.first, x.end, x.hash]),
    encoded.chunkEvidence.map((x) => [x.first, x.end, x.hash]),
  );
  assert(encoded.chunkEvidence.length > 0);
  assert.equal(encoded.pcmReader.length, 3);
  for (const source of encoded.pcmReader) {
    assert(source.identity.originalHash);
    assert.equal(source.backend.backend, audit.mode);
    assert.equal(source.backend.fallback, false);
    assert(source.backend.completedRequests > 0);
    if (audit.mode === 'wasm') {
      assert(source.backend.invocations > 0);
      assert.equal(source.backend.invocations, source.backend.completions);
    }
  }
  assert.equal(backend.configured, audit.mode);
  assert.equal(backend.realmBytes, backend.moduleBytes);
  assert(backend.realmPeak <= 8 * 1024 * 1024);
  assert(backend.sessions.some((x) => x.completedRequests > 0));
  for (const session of backend.sessions) {
    assert.equal(session.backend, audit.mode);
    assert.equal(session.fallback, false);
    assert.equal(session.drained, true);
    assert.equal(session.externalBytes, 0);
    if (audit.mode === 'wasm') assert.equal(session.wasmSha256, PCM_WASM_SHA);
  }
  assert.deepEqual(JSON.parse(await page.locator('#native').textContent()), audit.native);
  return { ...audit, encoded, backend };
}

export async function auditStartup(page, mode) {
  const state = await page.evaluate(() => globalThis.privatePcmDiagnostics());
  assert.equal(state.configured, mode);
  assert.equal(state.moduleBytes, mode === 'wasm' ? 4972 : 0);
  assert.equal(state.realmBytes, state.moduleBytes);
  assert.deepEqual(state.sessions, []);
  return state;
}
