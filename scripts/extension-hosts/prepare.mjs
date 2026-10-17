// Local-only: two separate consumers, same verified editor tarball, pinned source bytes.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { pinnedSource, digest } from '../extension-packaging/source.mjs';
import { assertOutsideCheckout } from './paths.mjs';
const [kitArg, expectedCommit, expectedDigest, outArg] = process.argv.slice(2);
const kit = path.resolve(kitArg),
  out = path.resolve(outArg),
  repo = process.cwd();
await assertOutsideCheckout(repo, out);
const source = pinnedSource(repo, expectedCommit);
assert.equal(
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  '',
  'clean source',
);
const raw = await readFile(path.join(kit, 'provenance.json'));
assert.equal(digest(raw), expectedDigest, 'externally pinned provenance');
const evidence = JSON.parse(raw);
assert.equal(evidence.sourceCommit, expectedCommit);
const sample = evidence.packages.find((p) => p.name === '@editor-platform/extension-sample');
const allPackages = [...evidence.packages, ...(evidence.thirdParty ?? [])];
const tarballs = [];
for (const pkg of allPackages) {
  const file = path.join(kit, 'tarballs', pkg.tarball);
  assert.equal(digest(await readFile(file)), pkg.sha256);
  tarballs.push(file);
}
await mkdir(out);
const env = {
  ...process.env,
  NODE_PATH: '',
  npm_config_registry: 'http://127.0.0.1:9',
  npm_config_cache: '/tmp/issue76-npm-cache',
};
// Repack only already-installed, lock-pinned build tools; retain their license files.
const toolDirectory = path.join(out, 'build-tools');
await mkdir(toolDirectory);
const lock = JSON.parse(source.read('package-lock.json'));
const toolPins = [];
for (const name of ['esbuild', 'typescript', '@esbuild/linux-x64']) {
  const installed = path.join(repo, 'node_modules', name);
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json')));
  assert.equal(
    manifest.version,
    lock.packages['node_modules/' + name].version,
    'reviewed build-tool version',
  );
  const packed = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        installed,
        '--ignore-scripts',
        '--offline',
        '--json',
        '--pack-destination',
        toolDirectory,
      ],
      { cwd: repo, env, encoding: 'utf8' },
    ),
  )[0];
  const file = path.join(toolDirectory, packed.filename);
  tarballs.push(file);
  toolPins.push({
    name,
    version: manifest.version,
    lockIntegrity: lock.packages['node_modules/' + name].integrity,
    tarball: packed.filename,
    sha256: digest(await readFile(file)),
  });
}
await writeFile(path.join(out, 'build-tools.json'), JSON.stringify(toolPins, null, 2));
async function inventory(dir, prefix = '') {
  const files = {};
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name),
      stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) Object.assign(files, await inventory(file, prefix + name + '/'));
    else files[prefix + name] = digest(await readFile(file));
  }
  return files;
}
for (const kind of ['reference', 'independent']) {
  const directory = path.join(out, kind);
  await mkdir(directory);
  const files = await source.stage(`examples/${kind}-extension-host`, directory);
  await writeFile(
    path.join(directory, 'editor-pin.json'),
    JSON.stringify({
      sourceCommit: expectedCommit,
      sha256: sample.sha256,
      packages: Object.fromEntries(evidence.packages.map((p) => [p.name, p.sha256])),
    }),
  );
  const run = (args) => execFileSync('npm', args, { cwd: directory, env, encoding: 'utf8' });
  // Exact declared build tools come only from the existing reviewed npm cache; no network.
  const install = run([
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    '/tmp/issue76-npm-cache',
    '--no-save',
    '--omit=optional',
    ...tarballs,
  ]);
  for (const pkg of allPackages)
    assert.deepEqual(
      await inventory(path.join(directory, 'node_modules', pkg.name)),
      pkg.files,
      'installed bytes',
    );
  const types = run(['run', 'typecheck']),
    build = run(['run', 'build']);
  const inputs = JSON.parse(await readFile(path.join(directory, 'build-inputs.json')));
  for (const name of Object.keys(inputs.inputs)) {
    assert.ok(
      [
        'main.ts',
        'providers.ts',
        'readonly.ts',
        'animation.ts',
        'video-edit.ts',
        'video-storage.ts',
        'media-demo.ts',
        'media-preview.ts',
        'media-fixtures.ts',
        'geo-edit.ts',
        'geo-save.ts',
        'geo-import.ts',
        'geo-import-sources.ts',
        'geo-source-save.ts',
        'geo-source-envelope.ts',
        'geo-source-storage.ts',
        'geo-source-adapter.ts',
        'geo-source-profile.ts',
        'geo-storage.ts',
        '<define:EDITOR_PINS>',
      ].includes(name) ||
        name.startsWith('node_modules/@editor-platform/') ||
        /^(node_modules\/(react|react-dom|scheduler)\/)/.test(name),
      'no checkout fallback',
    );
    if (kind === 'independent')
      assert.ok(!/extension-runtime\/dist\/.*reference/.test(name), 'no reference helper');
  }
  await writeFile(
    path.join(directory, 'verification.json'),
    JSON.stringify(
      {
        sourceCommit: expectedCommit,
        editorSha256: sample.sha256,
        sourceFiles: files,
        install,
        types,
        build,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS',
    kind,
    'outside checkout, offline install, types/build, verified tarball',
    sample.sha256,
  );
}
