/** Adversarial integration regression: passing audio cannot erase a failed baseline video gate. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
const [baseline, deps, out] = process.argv.slice(2);
assert(baseline && deps && out);
await mkdir(out);
await mkdir(out + '/input');
await mkdir(out + '/input/results');
const report = JSON.parse(await readFile(baseline + '/results/report.json', 'utf8'));
const source = report.rows.find((r) => r.name === 'n48000-r48000-o0');
assert(source && source.videoPass === true, 'Known passing video fixture required');
const row = { ...source, videoPass: false };
await writeFile(out + '/input/results/report.json', JSON.stringify({ ...report, rows: [row] }));
await symlink(
  resolve(baseline, 'results', row.name + '.webm'),
  out + '/input/results/' + row.name + '.webm',
);
const run = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('./repair-check.mjs', import.meta.url)),
    out + '/input',
    deps,
    out + '/output',
  ],
  { encoding: 'utf8', timeout: 120000 },
);
assert.equal(run.error, undefined);
assert.equal(run.status, 2, run.stderr);
const actual = JSON.parse(await readFile(out + '/output/report.json', 'utf8'));
assert.deepEqual(actual.errors, []);
assert.equal(actual.rows.length, 1);
assert(
  Object.values(actual.rows[0].qualities)
    .flat()
    .every((q) => q.pass),
  'Audio must independently pass for this regression',
);
assert.equal(actual.rows[0].videoPass, false);
assert.equal(actual.rows[0].state, 'FAIL');
process.stdout.write('PASS: repaired audio preserves baseline video failure\n');
