import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Reproducible native rough by default. Optional original illustrations stay outside Git.
const args = process.argv.slice(2);
if (args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--out', '--assets'].includes(arg)))
  throw Error(
    'Usage: node scripts/dev/prepare-manga-workspace-demo.mjs [--out DIRECTORY] [--assets DIRECTORY]',
  );
const options = Object.fromEntries(
  Array.from({ length: args.length / 2 }, (_, i) => args.slice(i * 2, i * 2 + 2)),
);
const output = path.resolve(options['--out'] ?? 'work/manga-workspace-demo');
await mkdir(output, { recursive: true });
const bundle = path.join(output, 'fixture.mjs');
await build({
  stdin: {
    contents:
      "export { mangaWorkspaceFixture } from './tests/fixtures/manga-workspace'; export { commitVersion } from '@editor-platform/artifact-core'; export { captureDesignPages } from '@editor-platform/design/pagination';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
});
const { mangaWorkspaceFixture, commitVersion, captureDesignPages } = await import(
  pathToFileURL(bundle).href
);
const images = {};
if (options['--assets']) {
  for (const name of ['harbor', 'resolve', 'hero', 'impact', 'compass', 'departure'])
    images[name] =
      'data:image/jpeg;base64,' +
      (await readFile(path.join(options['--assets'], `${name}.jpg`))).toString('base64');
}
const artifact = await commitVersion(
  mangaWorkspaceFixture(images),
  null,
  'Eight-panel demonstration',
);
const capture = await captureDesignPages(artifact, artifact.versions[0].versionId, {
  mode: 'vector',
});
if (!capture.ok) throw Error(JSON.stringify(capture.manifest.diagnostics));
await writeFile(path.join(output, 'native.json'), JSON.stringify(artifact));
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(capture.manifest, null, 2));
for (const [i, page] of capture.pages.entries())
  await writeFile(path.join(output, `page-${i + 1}.svg`), page.svg);
process.stdout.write(
  JSON.stringify({
    output,
    pages: capture.pages.length,
    panels: artifact.draft.content.pagination.pages.map((p) => p.panelIds.length),
    illustrated: !!options['--assets'],
    diagnostics: capture.manifest.diagnostics,
  }) + '\n',
);
