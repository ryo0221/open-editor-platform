import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRow } from '../../docs/workflow/tables.mjs';

const tables = fileURLToPath(new globalThis.URL('../../docs/workflow/tables.mjs', import.meta.url));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', ...args], {
    cwd,
    encoding: 'utf8',
  });
const put = (root, file, value) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
};
const get = (root, file) =>
  existsSync(path.join(root, file))
    ? JSON.parse(readFileSync(path.join(root, file), 'utf8'))
    : undefined;
const wording = 'docs/workflow/screens/wording.json';
const row = (id, text, source = 'a.ts') => ({ id, text, type: '操作', source });

/** A repository whose main split the wording table after `base`, and a branch that edited the old file. */
function repo(t, mainChange, branchRows) {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-tables-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(root, 'docs/workflow'), { recursive: true });
  copyFileSync(tables, path.join(root, 'docs/workflow/tables.mjs'));
  copyFileSync(
    fileURLToPath(new globalThis.URL('../../docs/workflow/markdown.mjs', import.meta.url)),
    path.join(root, 'docs/workflow/markdown.mjs'),
  );
  put(root, wording, { rows: [row('WD-1', 'あ'), row('WD-2', 'い'), row('WD-3', 'う')] });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', 'work');
  rmSync(path.join(root, wording));
  for (const r of [row('WD-1', 'あ'), row('WD-2', 'い'), row('WD-3', 'う')])
    put(root, `docs/workflow/screens/wording/${r.id}.json`, r);
  mainChange(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'split');
  git(root, 'checkout', '-q', 'work');
  put(root, wording, { rows: branchRows });
  git(root, 'commit', '-qam', 'branch');
  spawnSync('git', ['merge', '-q', 'main'], { cwd: root });
  const base = git(root, 'merge-base', 'HEAD', 'MERGE_HEAD').trim();
  const run = (b = base) =>
    spawnSync('node', ['docs/workflow/tables.mjs', 'migrate', b], { cwd: root, encoding: 'utf8' });
  return { root, run };
}

test('mergeRow takes each side’s changed fields and reports the same field changed both ways', () => {
  const base = row('WD-1', 'あ');
  assert.deepEqual(
    mergeRow(base, row('WD-1', 'あ', 'b.ts'), row('WD-1', 'か')),
    row('WD-1', 'か', 'b.ts'),
  );
  assert.equal(mergeRow(base, row('WD-1', 'さ'), row('WD-1', 'か')), 'conflict');
  assert.equal(mergeRow(base, undefined, row('WD-1', 'か')), 'conflict');
  assert.equal(mergeRow(base, undefined, base), undefined);
  assert.equal(mergeRow(undefined, row('WD-4', 'え'), row('WD-4', 'お')), 'conflict');
});

test('migrate merges the branch’s rows into the rows main changed after the split', (t) => {
  const { root, run } = repo(
    t,
    (r) => put(r, 'docs/workflow/screens/wording/WD-1.json', row('WD-1', 'か')),
    [row('WD-1', 'あ', 'b.ts'), row('WD-3', 'う'), row('WD-4', 'え')],
  );
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const dir = 'docs/workflow/screens/wording';
  assert.deepEqual(get(root, `${dir}/WD-1.json`), row('WD-1', 'か', 'b.ts'));
  assert.equal(get(root, `${dir}/WD-2.json`), undefined);
  assert.deepEqual(get(root, `${dir}/WD-4.json`), row('WD-4', 'え'));
  assert.equal(existsSync(path.join(root, wording)), false);
});

test('migrate changes nothing when both sides changed a row or the base has no old table', (t) => {
  const { root, run } = repo(
    t,
    (r) => put(r, 'docs/workflow/screens/wording/WD-1.json', row('WD-1', 'か')),
    [row('WD-1', 'さ'), row('WD-3', 'う'), row('WD-4', 'え')],
  );
  const before = git(root, 'status', '--porcelain');
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /WD-1\.json：main とこのブランチの両方が変えた/);
  assert.equal(git(root, 'status', '--porcelain'), before);
  const split = run('main');
  assert.equal(split.status, 1);
  assert.match(split.stderr, /分ける前の main の commit を渡す/);
  assert.equal(git(root, 'status', '--porcelain'), before);
});
