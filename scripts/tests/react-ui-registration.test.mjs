import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';

test('generic declaration CLI emits candidates and compares new pins without executing Host code', async () => {
  const dir = resolve('work/issue-38/cli');
  await mkdir(dir, { recursive: true });
  const source = resolve('tests/fixtures/react-ui/portability-host.tsx');
  const implementationHash = createHash('sha256')
    .update(await readFile(source))
    .digest('hex'); // Host-supplied attestation
  const entry = {
    file: source,
    exportName: 'Panel',
    ref: {
      registryId: 'independent-host',
      componentId: 'Panel',
      version: '1.0.0',
      implementationHash,
    },
    import: { source: '@independent/ui', export: 'named', name: 'Panel' },
  };
  const request = {
    sourceRevision: 'independent-source-1',
    entries: [entry],
    policies: {
      '["independent-host","Panel"]': {
        layout: 'wrapper',
        sampleProps: { title: 'Independent page' },
      },
    },
  };
  const input = resolve(dir, 'request.json'),
    previous = resolve(dir, 'previous.json');
  await writeFile(input, JSON.stringify(request));
  const run = (args) =>
    JSON.parse(
      execFileSync(process.execPath, ['scripts/react-ui-register.mjs', input, ...args], {
        encoding: 'utf8',
      }),
    );
  const first = run([]);
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.candidates[0].layout, 'wrapper');
  assert.equal(first.candidates[0].slots.action.minimum, 0);
  assert.deepEqual(first.candidates[0].events.onPick.parameters, [
    { type: 'enum', values: ['done', 'open'] },
  ]);
  assert.equal(first.candidates[0].props.title.default, undefined);
  await writeFile(previous, JSON.stringify(first));
  request.sourceRevision = 'independent-source-2';
  entry.ref.version = '2.0.0';
  await writeFile(input, JSON.stringify(request));
  const second = run([previous]);
  assert.equal(second.differences.changes[0].kind, 'changed');
  assert.equal(second.differences.changes[0].before.ref.version, '1.0.0');
  assert.equal(second.differences.changes[0].after.ref.version, '2.0.0');
  assert.equal(JSON.parse(await readFile(previous, 'utf8')).candidates[0].ref.version, '1.0.0');
  for (const invalid of [
    { ...request, policy: {} },
    { ...request, entries: [{ ...entry, require: ['theme'] }] },
    { ...request, entries: [{ ...entry, ref: { ...entry.ref, source: 'unexpected' } }] },
    { ...request, entries: [{ ...entry, import: { ...entry.import, exportName: 'wrong' } }] },
    { ...request, policies: { '["independent-host","Panel"]': { sampleProp: {} } } },
    { ...request, tsconfig: null },
  ]) {
    await writeFile(input, JSON.stringify(invalid));
    const rejected = spawnSync(process.execPath, ['scripts/react-ui-register.mjs', input], {
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /Invalid extraction|Missing or unsupported field/);
  }
});

test('registration CLI rejects tsconfig option and extends parse errors before emitting candidates', async () => {
  const dir = resolve('work/issue-38/cli-config-errors');
  await mkdir(dir, { recursive: true });
  const config = resolve(dir, 'tsconfig.json');
  const input = resolve(dir, 'request.json');
  const entry = {
    file: resolve('tests/fixtures/react-ui/portability-host.tsx'),
    exportName: 'Panel',
    ref: {
      registryId: 'config-test',
      componentId: 'Panel',
      version: '1.0.0',
      implementationHash: 'a'.repeat(64),
    },
    import: { source: '@independent/ui', export: 'named', name: 'Panel' },
  };
  await writeFile(
    input,
    JSON.stringify({ sourceRevision: 'config-v1', tsconfig: config, entries: [entry] }),
  );
  for (const value of [
    { compilerOptions: { unknownCompilerOption: true } },
    { compilerOptions: { module: 'invalid-module' } },
    { extends: './missing-config.json' },
  ]) {
    await writeFile(config, JSON.stringify(value));
    const result = spawnSync(process.execPath, ['scripts/react-ui-register.mjs', input], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unknown compiler option|Argument for|Cannot read file/);
  }
});
