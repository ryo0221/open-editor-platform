/* global structuredClone */
// Run this copied file outside the repository. Only Node built-ins are used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const kit = path.dirname(fileURLToPath(import.meta.url));
const digest = (data) => createHash('sha256').update(data).digest('hex');
const raw = await readFile(path.join(kit, 'provenance.json'));
const [expectedCommit, expectedDigest, expectedProfile = 'baseline'] = process.argv.slice(2);
assert.match(expectedCommit ?? '', /^[a-f0-9]{40}$/);
assert.equal(digest(raw), expectedDigest, 'Host-pinned provenance digest');
const evidence = JSON.parse(raw);
assert.ok(['baseline', 'readonly-domains', 'controlled-animation'].includes(expectedProfile));
const names = [
  'artifact-core',
  'editor-core',
  'extension-contract',
  'extension-runtime',
  'animation-core',
  'animation-player',
  'extension-sample',
  ...(expectedProfile !== 'baseline'
    ? ['video-core', 'video-metadata', 'geo-core', 'geo-inspector']
    : []),
  ...(expectedProfile === 'controlled-animation'
    ? ['animation', 'extension-animation-adapter']
    : []),
].map((n) => '@editor-platform/' + n);
const externalNames =
  expectedProfile === 'controlled-animation'
    ? ['react', 'scheduler', 'react-dom', 'csstype', '@types/react', '@types/react-dom']
    : [];
const allPackages = [...evidence.packages, ...(evidence.thirdParty ?? [])];
function validate(metadata) {
  assert.deepEqual(
    (metadata.thirdParty ?? []).map((p) => p.name),
    externalNames,
    'closed original dependency set',
  );
  assert.equal(metadata.profile ?? 'baseline', expectedProfile, 'explicit package profile');
  assert.equal(metadata.sourceCommit, expectedCommit, 'source commit');
  assert.equal(metadata.runtime, '1.0.0-draft.2', 'unknown runtime');
  assert.deepEqual(
    metadata.packages.map((p) => p.name),
    names,
    'closed local package set',
  );
  for (const pkg of metadata.thirdParty ?? []) {
    assert.equal(path.basename(pkg.tarball), pkg.tarball);
    assert.match(pkg.sha256, /^[a-f0-9]{64}$/);
    assert.equal(pkg.manifest.name, pkg.name);
    assert.equal(pkg.manifest.version, pkg.version);
    assert.ok(
      Object.keys(pkg.files).some((file) => /license/i.test(file)),
      'original dependency license retained',
    );
    for (const dependency of Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.peerDependencies,
      ...pkg.manifest.optionalDependencies,
    }))
      assert.ok(externalNames.includes(dependency), 'closed third-party dependency');
  }
  for (const pkg of metadata.packages) {
    assert.equal(path.basename(pkg.tarball), pkg.tarball);
    assert.match(pkg.sha256, /^[a-f0-9]{64}$/);
    for (const [dependency, version] of Object.entries(pkg.dependencies)) {
      assert.equal(
        [...metadata.packages, ...(metadata.thirdParty ?? [])].find((p) => p.name === dependency)
          ?.version,
        version,
        'exact local dependency',
      );
      assert.ok(!/[*/:]|workspace/.test(version), 'no workspace/file/registry range');
    }
  }
}
validate(evidence);
for (const [file, expected] of Object.entries(evidence.kitSourceFiles)) {
  assert.equal(
    digest(await readFile(path.join(kit, path.basename(file)))),
    expected,
    'pinned Host fixture bytes',
  );
}
assert.throws(() => validate({ ...evidence, runtime: 'unknown' }), /unknown runtime/);
assert.throws(() => validate({ ...evidence, sourceCommit: '0'.repeat(40) }), /source commit/);
const altered = structuredClone(evidence);
altered.packages.at(-1).dependencies['@editor-platform/editor-core'] = 'workspace:*';
assert.throws(() => validate(altered), /dependency/);
const tarballs = [];
for (const pkg of allPackages) {
  const file = path.join(kit, 'tarballs', pkg.tarball);
  const bytes = await readFile(file);
  const verifyBytes = (input) =>
    assert.equal(digest(input), pkg.sha256, 'tarball integrity before install/import');
  verifyBytes(bytes);
  const tampered = new Uint8Array(bytes);
  tampered[0] ^= 1;
  assert.throws(
    () => verifyBytes(tampered),
    /tarball integrity/,
    'tampered bytes refused without execution',
  );
  tarballs.push(file);
}
const host = path.join(kit, 'host');
await mkdir(host); // Fresh independent Host; never overwrite a previous run.
await writeFile(
  path.join(host, 'package.json'),
  JSON.stringify({ name: 'independent-extension-host', private: true, type: 'module' }),
);
const env = { ...process.env, NODE_PATH: '', npm_config_registry: 'http://127.0.0.1:9' };
execFileSync(
  'npm',
  [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    path.join(kit, 'host-cache'),
    ...tarballs,
  ],
  { cwd: host, env, stdio: 'pipe' },
);
async function inventory(dir, prefix = '') {
  const result = {};
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name),
      stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink(), 'no workspace symlinks');
    if (stat.isDirectory()) Object.assign(result, await inventory(file, prefix + name + '/'));
    else result[prefix + name] = digest(await readFile(file));
  }
  return result;
}
assert.deepEqual(
  (await readdir(path.join(host, 'node_modules'))).sort(),
  [
    '.package-lock.json',
    '@editor-platform',
    ...(externalNames.length ? ['@types', 'csstype', 'react', 'react-dom', 'scheduler'] : []),
  ].sort(),
);
if (externalNames.length)
  assert.deepEqual((await readdir(path.join(host, 'node_modules/@types'))).sort(), [
    'react',
    'react-dom',
  ]);
assert.deepEqual(
  (await readdir(path.join(host, 'node_modules/@editor-platform'))).sort(),
  names.map((n) => n.split('/')[1]).sort(),
);
for (const pkg of allPackages) {
  const dir = path.join(host, 'node_modules', pkg.name);
  assert.deepEqual(
    await inventory(dir),
    pkg.files,
    'installed bytes/export/types/notices match provenance',
  );
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json')));
  if (pkg.name.startsWith('@editor-platform/')) {
    assert.deepEqual(manifest.exports, pkg.exports);
    assert.equal(manifest.private, true);
  } else assert.deepEqual(manifest, pkg.manifest);
}
await cp(path.join(kit, 'host.mjs'), path.join(host, 'host.mjs'));
await cp(path.join(kit, 'host-types.ts'), path.join(host, 'host-types.ts'));
await cp(path.join(kit, 'browser.ts'), path.join(host, 'browser.ts'));
await writeFile(path.join(host, 'provenance.json'), raw);
const result = execFileSync(process.execPath, ['host.mjs'], { cwd: host, env, encoding: 'utf8' });
await writeFile(path.join(kit, 'verification.txt'), result);
console.log(result);
console.log(
  'PASS: offline install, byte inventory, no workspace links, pre-import pins and negative probes',
);
