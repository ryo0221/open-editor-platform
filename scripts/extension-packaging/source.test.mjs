import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  pinnedSource,
  digest,
  dependencyClosure,
  auditTypeImports,
  scopePackage,
} from './source.mjs';
import { thirdPartyNames } from './third-party.mjs';
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
test('only exact reviewed JSON assets may be imported outside package src', () => {
  const check = (specifier) =>
    auditTypeImports(
      `import data from '${specifier}' with { type: 'json' };`,
      '/fixture/src/index.ts',
      sample,
      manifests,
      '/fixture/src',
      ['/fixture/data/manifest.json'],
    );
  check('../data/manifest.json');
  for (const specifier of [
    '../data/other.json',
    '../data/private.ts',
    '../node_modules/private.json',
    '../../other/data/manifest.json',
  ])
    assert.throws(() => check(specifier), /Private source escape/);
});
test('Geo-capable packaging profiles include the closed lock-pinned hash dependency', () => {
  assert.deepEqual(thirdPartyNames('baseline'), ['@noble/hashes']);
  assert.deepEqual(thirdPartyNames('readonly-domains'), ['@noble/hashes']);
  assert.deepEqual(thirdPartyNames('controlled-animation'), [
    'react',
    'scheduler',
    'react-dom',
    'csstype',
    '@types/react',
    '@types/react-dom',
    '@noble/hashes',
  ]);
  assert.throws(() => thirdPartyNames('unknown'), /Unknown packaging profile/);
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
test('a scoped package keeps only files and dependencies its listed entrypoints reach', () => {
  const files = new Map(
    Object.entries({
      'pkg/src/controlled.tsx':
        "import './controlled.css'; import { a } from './helper'; import type { C } from '@local/pkg/contract'; import { x } from '@local/core';",
      'pkg/src/controlled.css': '.a {}',
      'pkg/src/helper.ts': "export const a = 1; import type { T } from '@local/direct';",
      'pkg/src/contract.ts': 'export type C = 1;',
      'pkg/src/surface.tsx': "import { UI } from '@local/ui'; import { a } from './helper';",
    }),
  );
  const source = { has: (name) => files.has(name), read: (name) => files.get(name) };
  const manifest = {
    name: '@local/pkg',
    exports: {
      './controlled': './src/controlled.tsx',
      './contract': './src/contract.ts',
      './v2': './src/surface.tsx',
    },
    dependencies: { '@local/core': '*', '@local/direct': '*', '@local/ui': '*', react: '*' },
  };
  const scoped = scopePackage(source, 'pkg', manifest, ['./controlled', './contract']);
  assert.deepEqual([...scoped.files].sort(), [
    'pkg/src/contract.ts',
    'pkg/src/controlled.css',
    'pkg/src/controlled.tsx',
    'pkg/src/helper.ts',
  ]);
  assert.deepEqual(Object.keys(scoped.manifest.exports), ['./controlled', './contract']);
  assert.deepEqual(Object.keys(scoped.manifest.dependencies).sort(), [
    '@local/core',
    '@local/direct',
    'react',
  ]);
  assert.throws(
    () => scopePackage(source, 'pkg', manifest, ['./missing']),
    /Unknown scoped export/,
  );
  assert.throws(
    () =>
      scopePackage(
        source,
        'pkg',
        { ...manifest, exports: { './controlled': './src/controlled.tsx' } },
        ['./controlled'],
      ),
    /outside scope/,
  );
});
