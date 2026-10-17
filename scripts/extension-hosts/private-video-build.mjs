import { writeDigestProvenance } from '../../packages/video-metadata/file-backed-storage/integration/provenance.mjs';
import { requirePrivateVideoTarget } from './private-video-target.mjs';
import { productBuild } from '../../packages/video-metadata/host-media/product-build.mjs';
import { pcmBuild, PCM_CONSUMER } from './private-video-pcm-build.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
const [deps, output, target = 'video-v1-review'] = process.argv.slice(2);
assert(['video-v1-review', 'video-v2-review'].includes(target));
const m2 = target === 'video-v2-review';
assert(deps && output && path.resolve(output).startsWith('/tmp/'));
assert.equal(
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  '',
  'Clean source required',
);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await mkdir(output); // Immutable separate build evidence.
const pcm = await pcmBuild(
  target,
  process.env.EDITOR_PRIVATE_VIDEO_M2_PCM_MODE,
  process.env.EDITOR_PRIVATE_VIDEO_M2_PCM_KERNEL,
  output,
);
let notices = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
for (const name of ['mediabunny', '@mediabunny/aac-encoder']) {
  const pkg = JSON.parse(await readFile(path.join(deps, 'node_modules', name, 'package.json')));
  assert.equal(pkg.version, '1.61.3');
  notices +=
    `\n\n${name} ${pkg.version}\n` +
    (await readFile(path.join(deps, 'node_modules', name, 'LICENSE'), 'utf8'));
}
notices += pcm.notices ?? '';
const result = await productBuild(deps, {
  entryPoint: m2
    ? 'apps/playground/src/private-video-m2/runtime-entry.mjs'
    : 'apps/playground/src/private-video/runtime-entry.mjs',
  metafile: true,
  banner: { js: '/*! Private reviewed Video build; see private-video-NOTICES.txt. */' },
  define: pcm.define,
});
requirePrivateVideoTarget(result, target);
await writeDigestProvenance(output, result, m2 ? 'normal-playground-m2' : 'normal-playground');
const provenance = await readFile(path.join(output, 'digest-provenance.json'));
const bytes = result.outputFiles[0].contents;
const digest = createHash('sha256').update(bytes).digest();
await writeFile(path.join(output, 'runtime.js'), bytes);
await writeFile(path.join(output, 'notices.txt'), notices);
await writeFile(path.join(output, 'inputs.json'), JSON.stringify(result.metafile, null, 2));
await writeFile(
  path.join(output, 'manifest.json'),
  JSON.stringify(
    {
      sourceCommit,
      target,
      digestProvenanceSha256: createHash('sha256').update(provenance).digest('hex'),
      noticesSha256: createHash('sha256').update(notices).digest('hex'),
      dependency: m2 ? PCM_CONSUMER : '3b45be9f53e7a32c881f226cd0e5a44728fc449e',
      ...(m2 ? { pcmBackend: pcm.manifest } : {}),
      frameReservation: 'bbc154f980d6f63b2c113d60070124c2206be6a6',
      sha256: digest.toString('hex'),
      integrity: 'sha256-' + digest.toString('base64'),
    },
    null,
    2,
  ),
);
