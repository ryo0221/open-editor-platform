/** Actual official-kernel startup/transfer proof; fresh evidence outside Git. */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
const [wasm, out] = process.argv.slice(2);
assert(wasm && out && !path.resolve(out).startsWith(process.cwd() + '/'));
const code = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
await mkdir(out);
const file = path.join(out, 'check.mjs');
await build({
  entryPoints: ['packages/video-core/experiments/pcm-wasm-m2/startup-check.ts'],
  outfile: file,
  platform: 'node',
  format: 'esm',
  bundle: true,
});
execFileSync(process.execPath, [file, path.resolve(wasm), path.join(out, 'results.json')], {
  stdio: 'inherit',
});
await writeFile(path.join(out, 'source.json'), JSON.stringify({ code, workingTree: '' }, null, 2));
