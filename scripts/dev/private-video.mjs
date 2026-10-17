import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { validatePcmManifest } from '../extension-hosts/private-video-pcm-build.mjs';
/** Explicit private build only. No remote executable URLs or public schema additions. */
export function privateVideoBuild() {
  if (process.env.EDITOR_PRIVATE_VIDEO_M2_BUILD && !process.env.EDITOR_PRIVATE_VIDEO_BUILD)
    throw Error('M2 validation requires the coordinated v1 build');
  return [configured(false), configured(true)];
}
function configured(m2) {
  const directory =
    process.env[m2 ? 'EDITOR_PRIVATE_VIDEO_M2_BUILD' : 'EDITOR_PRIVATE_VIDEO_BUILD'];
  const suffix = m2 ? 'private-video-m2' : 'private-video';
  const target = m2 ? 'video-v2-review' : 'video-v1-review';
  const id = '\0' + suffix + '-build';
  let asset, notices, manifest;
  if (directory) {
    manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    asset = readFileSync(path.join(directory, 'runtime.js'));
    notices = readFileSync(path.join(directory, 'notices.txt'));
    const proofBytes = readFileSync(path.join(directory, 'digest-provenance.json'));
    const proof = JSON.parse(proofBytes);
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const license = readFileSync('node_modules/@noble/hashes/LICENSE');
    if (m2) {
      validatePcmManifest(manifest.pcmBackend);
      if (manifest.pcmBackend.mode === 'wasm') {
        const kernelBytes = readFileSync(path.join(directory, 'pcm-kernel-manifest.json'));
        if (hash(kernelBytes) !== manifest.pcmBackend.kernelManifestSha256)
          throw Error('Private PCM kernel manifest drift');
        const kernel = JSON.parse(kernelBytes);
        for (const [name, expected] of Object.entries(kernel.notices)) {
          if (path.isAbsolute(name) || name.includes('..')) throw Error('Private PCM notice path');
          const license = readFileSync(path.join(directory, 'pcm-kernel-notices', name));
          if (hash(license) !== expected || !notices.includes(license))
            throw Error('Private PCM notice drift');
        }
      }
    }
    if (
      manifest.sourceCommit !==
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() ||
      createHash('sha256').update(asset).digest('hex') !== manifest.sha256
    )
      throw Error('Private Video source/bundle pin mismatch');
    if (
      hash(proofBytes) !== manifest.digestProvenanceSha256 ||
      hash(notices) !== manifest.noticesSha256 ||
      manifest.target !== target ||
      proof.owner !== (m2 ? 'normal-playground-m2' : 'normal-playground') ||
      proof.bundleSha256 !== manifest.sha256 ||
      proof.noticeSha256 !== hash(license) ||
      !notices.includes(license) ||
      proof.packageLockSha256 !== hash(readFileSync('package-lock.json')) ||
      !proof.installedInputs?.length ||
      proof.installedInputs.some(
        (input) =>
          !input.path.startsWith('node_modules/@noble/hashes/') ||
          input.path.includes('..') ||
          hash(readFileSync(input.path)) !== input.sha256,
      )
    )
      throw Error('Private Video digest provenance/notice mismatch');
  }
  return {
    name: 'private-normal-' + suffix,
    resolveId(source) {
      if (source === 'virtual:' + suffix + '-build') return id;
    },
    load(source) {
      if (source === id)
        return `export default ${JSON.stringify(asset ? { enabled: true, integrity: manifest.integrity, pin: manifest.sourceCommit } : { enabled: false })};`;
    },
    configureServer(server) {
      if (!asset) return;
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' + suffix + '-runtime.js') {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(asset);
        } else if (req.url === '/' + suffix + '-NOTICES.txt') {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(notices);
        } else next();
      });
    },
    generateBundle() {
      if (asset) {
        this.emitFile({ type: 'asset', fileName: suffix + '-runtime.js', source: asset });
        this.emitFile({ type: 'asset', fileName: suffix + '-NOTICES.txt', source: notices });
      }
    },
  };
}
