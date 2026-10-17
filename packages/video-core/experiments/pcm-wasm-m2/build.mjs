/** Explicit private successor build, using the accepted product builder and hash-pinned kernel. */
import { productBuild } from '../../../video-metadata/host-media/product-build.mjs';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
export async function consumerBuild(deps, options) {
  const mode = process.env.M2_PCM_MODE ?? 'js';
  assert.ok(['js', 'wasm'].includes(mode));
  const out = resolve(process.env.M2_PCM_BUILD);
  assert.ok(out.startsWith('/tmp/'));
  const kernelRoot = resolve(process.env.M2_PCM_KERNEL ?? '/tmp/m2-pcm-final-kernel');
  const kernel = await readFile(resolve(kernelRoot, 'pcm.wasm'));
  const manifest = JSON.parse(await readFile(resolve(kernelRoot, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.memoryPages, [12, 12]);
  assert.deepEqual(manifest.imports, []);
  assert.equal(manifest.bytes, 4972);
  await cp(resolve(kernelRoot, 'notices'), resolve(out, 'kernel-notices'), { recursive: true });
  await cp(resolve(kernelRoot, 'manifest.json'), resolve(out, 'kernel-manifest.json'));
  for (const name of ['mediabunny', '@mediabunny/aac-encoder']) {
    const root = resolve(deps, 'node_modules', name);
    assert.equal(
      JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version,
      '1.61.3',
    );
    await cp(resolve(root, 'LICENSE'), resolve(out, name.replaceAll('/', '_') + '-LICENSE.txt'));
  }
  const sha = createHash('sha256').update(kernel).digest('hex');
  assert.equal(sha, '142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca');
  assert.equal(manifest.wasmSha256, sha);
  const entry = resolve(out, 'entry.mjs');
  await writeFile(
    entry,
    `import {configureM2Pcm,m2PcmDiagnostics} from ${JSON.stringify(resolve('packages/video-core/experiments/pcm-wasm-m2/owners.ts'))};\nimport ${JSON.stringify(resolve(options.entryPoint))};\nimport ${JSON.stringify(resolve('packages/video-core/experiments/pcm-wasm-m2/observe-validation.mjs'))};\nconfigureM2Pcm(${JSON.stringify(mode)},${mode === 'wasm' ? `new Uint8Array(${JSON.stringify([...kernel])})` : 'undefined'});\nglobalThis.privatePcmDiagnostics=m2PcmDiagnostics;`,
  );
  const built = await productBuild(deps, { ...options, entryPoint: entry, metafile: true });
  await writeFile(resolve(out, 'runtime.js'), built.outputFiles[0].contents);
  await writeFile(resolve(out, 'inputs.json'), JSON.stringify(built.metafile, null, 2));
  await writeFile(
    resolve(out, 'backend.json'),
    JSON.stringify(
      {
        mode,
        wasmSha256: sha,
        bundleSha256: createHash('sha256').update(built.outputFiles[0].contents).digest('hex'),
      },
      null,
      2,
    ),
  );
  return built;
}
