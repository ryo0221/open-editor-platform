import { readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

export const PCM_CONSUMER = 'd784f3f097138587c62be3f3c1f15585890ae763';
export const PCM_WASM_SHA = '142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function pcmMode(target, selected) {
  const mode = selected === undefined ? 'js' : selected;
  assert(['js', 'wasm'].includes(mode), 'Unknown private PCM mode');
  assert(target === 'video-v2-review' || selected === undefined, 'PCM selection is M2-only');
  return mode;
}
export function validatePcmManifest(value) {
  assert(value && ['js', 'wasm'].includes(value.mode), 'Private PCM manifest mode');
  assert.equal(value.consumer, PCM_CONSUMER, 'Private PCM consumer pin');
  const keys = ['consumer', 'mode'];
  if (value.mode === 'wasm') {
    keys.push('kernelManifestSha256', 'wasmSha256');
    assert.equal(value.wasmSha256, PCM_WASM_SHA, 'Private PCM kernel pin');
    assert.match(value.kernelManifestSha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'Private PCM manifest fields');
}
export async function pcmBuild(target, selected, kernelRoot, output) {
  const mode = pcmMode(target, selected);
  if (target !== 'video-v2-review') return {};
  const manifest = { mode, consumer: PCM_CONSUMER };
  const define = { __EDITOR_PRIVATE_M2_PCM_MODE__: JSON.stringify(mode) };
  let notices = '';
  if (mode === 'wasm') {
    assert(kernelRoot, 'Explicit verified kernel directory required');
    const bytes = await readFile(path.join(kernelRoot, 'pcm.wasm'));
    const proofBytes = await readFile(path.join(kernelRoot, 'manifest.json'));
    const proof = JSON.parse(proofBytes);
    assert.equal(hash(bytes), PCM_WASM_SHA, 'Private PCM kernel bytes');
    assert.equal(proof.wasmSha256, PCM_WASM_SHA);
    assert.equal(bytes.length, 4972);
    assert.equal(proof.bytes, bytes.length);
    assert.equal(proof.workingTree, '');
    assert.deepEqual(proof.memoryPages, [12, 12]);
    assert.deepEqual(proof.imports, []);
    assert.equal(proof.target, 'wasm32-unknown-unknown');
    assert.match(proof.sourceCommit, /^[a-f0-9]{40}$/);
    for (const [name, expected] of Object.entries(proof.inputs)) {
      assert(!path.isAbsolute(name) && !name.includes('..'));
      assert.equal(
        hash(await readFile(path.join('packages/video-core/experiments/pcm-wasm-r0', name))),
        expected,
        'Private PCM source input drift',
      );
    }
    assert.deepEqual(
      Object.keys(proof.inputs).sort(),
      [
        'Cargo.lock',
        'Cargo.toml',
        'build.mjs',
        'rust-toolchain.toml',
        'src/lib.rs',
        'toolchain-inputs.json',
      ].sort(),
    );
    assert(Object.keys(proof.notices).length > 0);
    for (const [name, expected] of Object.entries(proof.notices)) {
      assert(!path.isAbsolute(name) && !name.includes('..'));
      const license = await readFile(path.join(kernelRoot, 'notices', name));
      assert.equal(hash(license), expected, 'Private PCM notice drift');
      notices += '\n\nPrivate PCM kernel: ' + name + '\n' + license.toString('utf8');
    }
    await cp(path.join(kernelRoot, 'notices'), path.join(output, 'pcm-kernel-notices'), {
      recursive: true,
    });
    await writeFile(path.join(output, 'pcm-kernel-manifest.json'), proofBytes);
    manifest.wasmSha256 = PCM_WASM_SHA;
    manifest.kernelManifestSha256 = hash(proofBytes);
    define.__EDITOR_PRIVATE_M2_PCM_BYTES__ = JSON.stringify([...bytes]);
  }
  validatePcmManifest(manifest);
  return { manifest, define, notices };
}
