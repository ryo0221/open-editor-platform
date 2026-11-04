#!/usr/bin/env node
// Downloads a released CAD kernel instead of rebuilding it (README.md, "Released builds").
// node scripts/cad-kernel/fetch.mjs <out-dir> [--build <wasm sha256 prefix>] [--source]
// The Wasm must match build.mjs and the loader its jsSha256; the other files must match the
// release's SHA256SUMS. Nothing is written to <out-dir> unless every check passes.
/* global fetch */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cadKernelBuild, cadKernelPrevious, cadKernelRelease } from './build.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The release tag of a build: `cad-kernel-` and the first 12 hex digits of its Wasm hash. */
export const cadKernelReleaseTag = (spec) => `cad-kernel-${spec.wasmSha256.slice(0, 12)}`;
/** Release asset names of a build. The source bundle is one tar of bundle.sh's `source/`. */
export const cadKernelReleaseFiles = (spec) => ({
  js: spec.js,
  wasm: spec.wasm,
  types: spec.wasm.replace(/\.wasm$/, '.d.ts'),
  notice: 'NOTICE.txt',
  source: 'cad-kernel-source.tar',
  sums: 'SHA256SUMS',
});

/** The build.mjs entry a Wasm hash prefix names (the current build when none is given). */
export function cadKernelSpec(
  prefix,
  { current = cadKernelBuild, previous = cadKernelPrevious } = {},
) {
  if (!prefix) return current;
  const found = [current, ...previous].filter((s) => s.wasmSha256.startsWith(prefix.toLowerCase()));
  if (found.length !== 1)
    throw new Error(
      `--build ${prefix}: ${found.length ? 'ambiguous' : 'not a build in build.mjs'}`,
    );
  return found[0];
}

export async function fetchCadKernel(
  out,
  spec,
  { source = false, baseUrl = cadKernelReleaseUrl(), fetchImpl = fetch } = {},
) {
  if (!spec.jsSha256)
    throw new Error(`${cadKernelReleaseTag(spec)}: build.mjs has no jsSha256 for this build`);
  if (spec.revoked) throw new Error(`${cadKernelReleaseTag(spec)}: this build is revoked`);
  const files = cadKernelReleaseFiles(spec);
  const tag = cadKernelReleaseTag(spec);
  const get = async (name) => {
    const res = await fetchImpl(`${baseUrl}/${tag}/${name}`);
    if (!res.ok) throw new Error(`${tag}/${name}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const sums = new Map(
    (await get(files.sums))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
        if (!m) throw new Error(`${tag}/${files.sums}: malformed line`);
        return [m[2], m[1]];
      }),
  );
  const names = [
    files.js,
    files.wasm,
    files.types,
    files.notice,
    ...(source ? [files.source] : []),
  ];
  const expected = (name) =>
    name === files.wasm ? spec.wasmSha256 : name === files.js ? spec.jsSha256 : sums.get(name);
  const downloaded = new Map();
  for (const name of names) {
    const bytes = await get(name);
    const want = expected(name);
    if (!want) throw new Error(`${tag}/${name}: not listed in ${files.sums}`);
    if (sha256(bytes) !== want)
      throw new Error(`${tag}/${name}: SHA-256 ${sha256(bytes)} differs from ${want}`);
    downloaded.set(name, bytes);
  }
  await mkdir(out, { recursive: true });
  const staging = await mkdtemp(path.join(out, '.fetch-'));
  try {
    for (const [name, bytes] of downloaded) await writeFile(path.join(staging, name), bytes);
    if (source) {
      // Unpack apart from the checked files, accept only plain files and directories under
      // source/, and check the bundle's own checksums before the installed source is replaced.
      const tar = path.join(staging, files.source);
      const members = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).split('\n');
      const outside = members.find(
        (m) => m && (!/^source(\/|$)/.test(m) || m.split('/').includes('..')),
      );
      if (outside !== undefined) throw new Error(`${tag}/${files.source}: member outside source/`);
      const unpack = path.join(staging, 'unpack');
      await mkdir(unpack);
      execFileSync('tar', ['-xf', tar, '-C', unpack]);
      await assertPlainTree(unpack, `${tag}/${files.source}`);
      await writeFile(path.join(unpack, files.notice), downloaded.get(files.notice));
      execFileSync('sha256sum', ['--quiet', '-c', 'source/SHA256SUMS'], { cwd: unpack });
      await rm(path.join(out, 'source'), { recursive: true, force: true });
      await rename(path.join(unpack, 'source'), path.join(out, 'source'));
    }
    for (const name of names.filter((n) => n !== files.source))
      await rename(path.join(staging, name), path.join(out, name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { tag, files: names };
}

/** Throws unless `dir` holds only `source/` with plain files and directories below it. */
async function assertPlainTree(dir, label) {
  // Dirents describe the entries themselves, so a `source` symlink is not taken for a directory.
  const top = await readdir(dir, { withFileTypes: true });
  if (top.length !== 1 || top[0].name !== 'source' || !top[0].isDirectory())
    throw new Error(`${label}: no single source/ directory`);
  for (const entry of await readdir(path.join(dir, 'source'), {
    recursive: true,
    withFileTypes: true,
  }))
    if (!entry.isFile() && !entry.isDirectory())
      throw new Error(`${label}: ${entry.name} is not a plain file or directory`);
}

/** Where releases are downloaded from; CAD_KERNEL_RELEASE_URL overrides it (a mirror). */
function cadKernelReleaseUrl() {
  return (
    process.env.CAD_KERNEL_RELEASE_URL ??
    `https://github.com/${cadKernelRelease.repository}/releases/download`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--build');
  if (!out) {
    console.error('usage: fetch.mjs <out-dir> [--build <wasm sha256 prefix>] [--source]');
    process.exit(2);
  }
  const build = args.includes('--build') ? args[args.indexOf('--build') + 1] : undefined;
  const spec = cadKernelSpec(build);
  const { tag } = await fetchCadKernel(path.resolve(out), spec, {
    source: args.includes('--source'),
  });
  console.log(`${tag}: ${spec.wasmSha256}  ${path.join(out, spec.wasm)}`);
}
