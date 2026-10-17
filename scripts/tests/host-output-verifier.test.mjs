import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { zipSync, strToU8 } from 'fflate';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'work/issue-33-36/independent-react');
const page = strToU8(
  "import {Title} from './Title';export function ProductPage(){return <Title/>;}",
);
const title = strToU8('export function Title(){return <h1>保存したReactページ</h1>;}');
async function directory(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'host-output-verifier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function run(archive) {
  return spawnSync(process.execPath, ['scripts/verify-host-react-output.mjs', archive], {
    cwd: root,
    encoding: 'utf8',
  });
}
test('independent verifier cannot reuse a dependency missing from the next ZIP', async (t) => {
  const dir = await directory(t);
  const archive = resolve(dir, 'output.zip');
  await writeFile(archive, zipSync({ 'ProductPage.tsx': page, 'Title.tsx': title }));
  const first = run(archive);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /PASS: actual UI ZIP/);
  await writeFile(archive, zipSync({ 'ProductPage.tsx': page }));
  const second = run(archive);
  assert.notEqual(second.status, 0);
  await assert.rejects(access(resolve(out, 'Title.tsx')));
});
for (const name of [
  '',
  '../outside.tsx',
  './bad.tsx',
  'nested//bad.tsx',
  'nested/../bad.tsx',
  'C:/bad.tsx',
  'nested\\bad.tsx',
]) {
  test(`verification archive rejects unsafe path ${JSON.stringify(name)} before extraction`, async (t) => {
    const dir = await directory(t),
      archive = resolve(dir, 'bad.zip');
    await writeFile(archive, zipSync({ [name]: title }));
    const result = run(archive);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid export path/);
  });
}
test('absolute archive path cannot overwrite a file outside the verification directory', async (t) => {
  const dir = await directory(t),
    target = resolve(dir, 'protected.tsx'),
    archive = resolve(dir, 'bad.zip');
  await writeFile(target, 'protected');
  await writeFile(archive, zipSync({ [target]: title }));
  const result = run(archive);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid export path/);
  assert.equal(await readFile(target, 'utf8'), 'protected');
});
