import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pinnedSource, digest, dependencyClosure, auditTypeImports } from './source.mjs';
const core = { name: '@local/core', exports: { '.': './index.js' } };
const direct = {
  name: '@local/direct',
  exports: { '.': './index.js' },
  dependencies: { '@local/core': '1' },
};
const unrelated = { name: '@local/unrelated', exports: { '.': './index.js' } };
const sample = {
  name: '@local/sample',
  dependencies: { '@local/direct': '1' },
  devDependencies: { '@local/unrelated': '1' },
};
const manifests = new Map([core, direct, unrelated, sample].map((value) => [value.name, value]));
const audit = (text) =>
  auditTypeImports(text, '/fixture/src/index.ts', sample, manifests, '/fixture/src');
test('declaration closure excludes unrelated/dev packages but includes transitive types', () => {
  assert.deepEqual(dependencyClosure(sample, manifests), ['@local/core', '@local/direct']);
  assert.throws(
    () => dependencyClosure({ dependencies: { missing: '*' } }, manifests),
    /Non-reviewed/,
  );
});
test('type-only direct public dependencies pass; hoisted transitive/undeclared/private imports fail', () => {
  audit(
    "import type { Thing } from '@local/direct'; export type { Thing } from '@local/direct'; type T = import('@local/direct').Thing;",
  );
  for (const name of ['@local/core', '@local/unrelated', '@local/direct/src/private']) {
    for (const text of [
      `import type { Thing } from '${name}';`,
      `export type { Thing } from '${name}';`,
      `type T = import('${name}').Thing;`,
      `import T = require('${name}');`,
      `/// <reference types="${name}" />`,
    ])
      assert.throws(() => audit(text), /Private\/undeclared import/, text);
  }
});
test('relative type imports cannot reach another package or private declaration files', () => {
  audit("import type { Thing } from './internal';");
  assert.throws(
    () => audit("type T = import('../node_modules/@local/core/private').Thing;"),
    /Private source escape/,
  );
});
test('only explicit tracked commit bytes are staged, irrespective of dirty/ignored/untracked files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'extension-source-'));
  try {
    const repo = path.join(dir, 'repo'),
      stage = path.join(dir, 'stage');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    await writeFile(path.join(repo, '.gitignore'), 'src/ignored.ts\n');
    await writeFile(path.join(repo, 'src/index.ts'), 'export const pin = 1;\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Packaging test',
      '-c',
      'user.email=packaging@example.invalid',
      'commit',
      '-qm',
      'pin',
    );
    const commit = git('rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'src/index.ts'), 'export const pin = 999;\n');
    await writeFile(path.join(repo, 'src/ignored.ts'), 'ignored');
    await writeFile(path.join(repo, 'src/untracked.ts'), 'untracked');
    const source = pinnedSource(repo, commit);
    const hashes = await source.stage('src', stage);
    assert.deepEqual(hashes, { 'src/index.ts': digest('export const pin = 1;\n') });
    assert.equal(await readFile(path.join(stage, 'index.ts'), 'utf8'), 'export const pin = 1;\n');
    assert.throws(() => source.read('src/ignored.ts'), /Not a tracked regular file/);
    assert.throws(() => pinnedSource(repo, 'HEAD'), /Full explicit/);
    await symlink('index.ts', path.join(repo, 'src/link.ts'));
    git('add', 'src/link.ts');
    git(
      '-c',
      'user.name=Packaging test',
      '-c',
      'user.email=packaging@example.invalid',
      'commit',
      '-qm',
      'symlink',
    );
    assert.throws(
      () => pinnedSource(repo, git('rev-parse', 'HEAD')).read('src/link.ts'),
      /Not a tracked regular file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('self package imports use only declared public entries without a dependency cycle', () => {
  const manifest = {
    name: '@scope/self',
    dependencies: {},
    exports: { '.': './src/index.ts', './contract': './src/contract.ts' },
  };
  const manifests = new Map([[manifest.name, manifest]]);
  assert.doesNotThrow(() =>
    auditTypeImports(
      "import type {X} from '@scope/self/contract';",
      'packages/self/src/index.ts',
      manifest,
      manifests,
      'packages/self/src',
    ),
  );
  assert.throws(
    () =>
      auditTypeImports(
        "import type {X} from '@scope/self/src/private';",
        'packages/self/src/index.ts',
        manifest,
        manifests,
        'packages/self/src',
      ),
    /Private\/undeclared/,
  );
  assert.deepEqual(dependencyClosure(manifest, manifests), []);
});
