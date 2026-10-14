import console from 'node:console';
import { build } from 'esbuild';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'editor-template-catalog-'));
try {
  const outfile = join(directory, 'catalog.mjs');
  await build({
    entryPoints: ['packages/templates/src/builtin-source.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
  });
  const { authoredCatalog } = await import(pathToFileURL(outfile));
  const definitions = await authoredCatalog();
  await writeFile(
    'packages/templates/src/builtins.json',
    JSON.stringify(definitions, null, 2) + '\n',
  );
  console.log(`Materialized ${definitions.length} immutable built-in definitions`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
