import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { build } from 'esbuild';
const base = dirname(fileURLToPath(import.meta.url)),
  [deps, outArg] = process.argv.slice(2);
if (!deps || !outArg)
  throw Error('Usage: real-library-check.mjs <verified deps root> <fresh external evidence dir>');
const root = resolve(deps, 'node_modules/mediabunny'),
  out = resolve(outArg);
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
if (out === repo || out.startsWith(repo + '/')) throw Error('Evidence must remain outside Git');
const bytes = readFileSync(resolve(base, 'library-evidence/inputs.json'));
const inputs = JSON.parse(bytes);
const sha = (data) => createHash('sha256').update(data).digest('hex');
for (const file of inputs.files)
  if (sha(readFileSync(resolve(root, file.path))) !== file.sha256)
    throw Error('Installed source drift: ' + file.path);
const actual = readdirSync(resolve(root, 'dist/modules'), { recursive: true })
  .filter((x) => x.endsWith('.js'))
  .map((x) => 'dist/modules/' + x)
  .sort();
if (
  JSON.stringify(actual) !==
  JSON.stringify(
    inputs.files
      .filter((x) => x.path.endsWith('.js'))
      .map((x) => x.path)
      .sort(),
  )
)
  throw Error('Runtime file set drift');
for (const e of inputs.excerpts) {
  const lines = readFileSync(resolve(root, e.source), 'utf8').split(/(?<=\n)/);
  if (lines.slice(e.firstLine - 1, e.lastLine).join('') !== e.text) throw Error('Excerpt drift');
}
mkdirSync(out);
const inventory = execFileSync(
  process.execPath,
  [resolve(base, 'aac-inventory.mjs'), resolve(deps)],
  { encoding: 'utf8' },
);
if (
  JSON.stringify(JSON.parse(inventory)) !==
  JSON.stringify(
    JSON.parse(readFileSync(resolve(base, 'library-evidence/aac-inventory.json'), 'utf8')),
  )
)
  throw Error('Recorded AAC inventory drift');
writeFileSync(resolve(out, 'aac-inventory.json'), inventory);
const bundle = resolve(out, 'real-library-fixture.mjs');
await build({
  entryPoints: [resolve(base, 'real-library-fixture.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
execFileSync(process.execPath, [bundle, root, out, sha(bytes)], { stdio: 'inherit' });
