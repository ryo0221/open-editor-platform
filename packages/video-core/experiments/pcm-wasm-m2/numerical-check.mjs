import process from 'node:process';
/** Explicit forced check: missing module is an error, never a skip or fallback. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = dirname(fileURLToPath(import.meta.url));
const [wasm, output] = process.argv.slice(2);
if (!wasm || !output)
  throw Error('Usage: node check.mjs <official pcm.wasm> <evidence directory outside Git>');
execFileSync(process.execPath, [resolve(base, '../pcm-wasm-m2-fixture/freeze.mjs')], {
  stdio: 'inherit',
});
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: base,
  encoding: 'utf8',
}).trim();
if (resolve(output) === repo || resolve(output).startsWith(repo + '/'))
  throw Error('Keep evidence outside Git');
mkdirSync(resolve(output)); // Fresh evidence only; preserve failures.
const bundle = resolve(output, 'fixture-check.mjs');
await build({
  entryPoints: [resolve(base, 'numerical-check.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
execFileSync(process.execPath, [bundle, resolve(wasm), resolve(output)], { stdio: 'inherit' });
