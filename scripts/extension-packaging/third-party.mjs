// Closed, already-installed lock-pinned React/type dependencies. No download or publication.
import { readFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
import { digest } from './source.mjs';
export const THIRD_PARTY_NAMES = [
  'react',
  'scheduler',
  'react-dom',
  'csstype',
  '@types/react',
  '@types/react-dom',
];
export async function packThirdParty(repo, output, source) {
  const lock = JSON.parse(source.read('package-lock.json')),
    results = [];
  const env = {
    ...process.env,
    NODE_PATH: '',
    npm_config_registry: 'http://127.0.0.1:9',
    npm_config_cache: '/tmp/issue76-npm-cache',
  };
  async function inventory(dir, prefix = '') {
    const files = {};
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name),
        stat = await lstat(file);
      assert.ok(!stat.isSymbolicLink(), 'no third-party source symlink');
      if (stat.isDirectory()) Object.assign(files, await inventory(file, prefix + name + '/'));
      else files[prefix + name] = digest(await readFile(file));
    }
    return files;
  }
  for (const name of THIRD_PARTY_NAMES) {
    const installed = path.join(repo, 'node_modules', name),
      manifest = JSON.parse(await readFile(path.join(installed, 'package.json'))),
      pin = lock.packages['node_modules/' + name];
    assert.equal(manifest.version, pin.version, 'lock-pinned installed dependency');
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
          path.join(output, 'tarballs'),
        ],
        { cwd: repo, env, encoding: 'utf8' },
      ),
    )[0];
    const tarball = path.join(output, 'tarballs', packed.filename),
      directory = path.join(output, 'third-party', name);
    await mkdir(directory, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', directory]);
    const files = await inventory(directory);
    assert.ok(
      Object.keys(files).some((file) => /license/i.test(file)),
      'original license file retained',
    );
    results.push({
      name,
      version: manifest.version,
      tarball: packed.filename,
      sha256: digest(await readFile(tarball)),
      lockIntegrity: pin.integrity,
      files,
      manifest,
      directory,
    });
  }
  return results;
}
