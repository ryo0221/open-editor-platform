import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function validateDigestOwners(lock, video, playground, owner) {
  if (!['video-fixture', 'normal-playground', 'normal-playground-m2'].includes(owner))
    throw Error('Unknown digest dependency owner');
  if (
    video.devDependencies?.['@noble/hashes'] !== '1.8.0' ||
    lock.packages['packages/video-metadata']?.devDependencies?.['@noble/hashes'] !== '1.8.0' ||
    video.dependencies?.['@noble/hashes'] !== undefined ||
    lock.packages['packages/video-metadata']?.dependencies?.['@noble/hashes'] !== undefined
  )
    throw Error('Video private digest development pin mismatch');
  if (
    owner !== 'video-fixture' &&
    (playground.dependencies?.['@noble/hashes'] !== '1.8.0' ||
      lock.packages['apps/playground']?.dependencies?.['@noble/hashes'] !== '1.8.0')
  )
    throw Error('Playground runtime digest pin mismatch');
}
/** Locked installed inputs -> local bundle evidence, deliberately not registry tarball attestation. */
export async function writeDigestProvenance(output, bundle, owner = 'video-fixture') {
  const lockBytes = await readFile('package-lock.json'),
    lock = JSON.parse(lockBytes),
    record = lock.packages['node_modules/@noble/hashes'];
  const manifest = JSON.parse(await readFile('packages/video-metadata/package.json', 'utf8'));
  const playground = JSON.parse(await readFile('apps/playground/package.json', 'utf8'));
  validateDigestOwners(lock, manifest, playground, owner);
  const installed = JSON.parse(await readFile('node_modules/@noble/hashes/package.json', 'utf8'));
  if (record.version !== '1.8.0' || installed.version !== '1.8.0' || installed.license !== 'MIT')
    throw Error('Digest manifest/lock/installed pin mismatch');
  const files = [];
  for (const name of Object.keys(bundle.metafile.inputs)
    .filter((name) => name.startsWith('node_modules/@noble/hashes/'))
    .sort())
    files.push({ path: name, sha256: hash(await readFile(name)) });
  if (!files.length) throw Error('Digest implementation not bundled');
  const notice = await readFile(
    'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  );
  const installedNotice = await readFile('node_modules/@noble/hashes/LICENSE');
  if (
    !notice.equals(installedNotice) ||
    hash(notice) !== '4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec'
  )
    throw Error('Full digest MIT notice mismatch');
  if (
    owner === 'normal-playground' &&
    !Object.hasOwn(bundle.metafile.inputs, 'apps/playground/src/private-video/runtime-entry.mjs')
  )
    throw Error('Normal private runtime entry missing');
  if (
    owner === 'normal-playground-m2' &&
    (!Object.hasOwn(
      bundle.metafile.inputs,
      'apps/playground/src/private-video-m2/runtime-entry.mjs',
    ) ||
      Object.hasOwn(bundle.metafile.inputs, 'apps/playground/src/private-video/runtime-entry.mjs'))
  )
    throw Error('M2 private runtime entry missing or mixed');
  const proof = {
    owner,
    dependency: '@noble/hashes',
    version: '1.8.0',
    license: 'MIT',
    lockRecord: record,
    packageLockSha256: hash(lockBytes),
    installedManifestSha256: hash(await readFile('node_modules/@noble/hashes/package.json')),
    installedInputs: files,
    noticeSha256: hash(notice),
    bundleSha256: hash(bundle.outputFiles[0].contents),
    claim:
      'Locked installed input-to-artifact provenance only; registry tarball bytes were not fetched or attested.',
  };
  await writeFile(join(output, 'digest-provenance.json'), JSON.stringify(proof, null, 2), {
    flag: 'wx',
  });
}
