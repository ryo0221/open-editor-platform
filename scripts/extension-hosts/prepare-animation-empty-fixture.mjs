import { build } from 'esbuild';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { mkdir, readdir, readFile, writeFile, copyFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
if (!process.argv[2] || !process.argv[3])
  throw Error('Usage: node prepare-animation-empty-fixture.mjs INPUT_CONSUMERS FRESH_OUTPUT');
const base = path.resolve(process.argv[2]),
  output = path.resolve(process.argv[3]);
if (base === output || base.startsWith(output + path.sep) || output.startsWith(base + path.sep))
  throw Error('Input and output must be separate directories');
await mkdir(output); // Require a fresh destination; never overwrite an existing consumer.
for (const kind of ['reference', 'independent']) {
  const source = `${base}/${kind}`,
    root = `${output}/${kind}`;
  await mkdir(`${root}/dist`, { recursive: true });
  for (const name of await readdir(source))
    if (
      name.endsWith('.ts') ||
      name === 'editor-pin.json' ||
      name === 'package.json' ||
      name === 'tsconfig.json'
    )
      await copyFile(`${source}/${name}`, `${root}/${name}`);
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
  const original = await readFile(`${source}/animation.ts`, 'utf8');
  const start = original.indexOf('const initial: AnimationContentV1 = {');
  const end = original.indexOf('\n};', start) + 3;
  if (start < 0 || end <= start) throw Error('initial-boundary');
  const initial =
    'const initial: AnimationContentV1 = ' +
    JSON.stringify({
      schemaVersion: 1,
      ticksPerSecond: 240000,
      rootCompositionId: 'root',
      assets: [],
      compositions: [
        {
          id: 'root',
          width: 640,
          height: 360,
          duration: 960000,
          frameRate: { numerator: 30, denominator: 1 },
          layers: [],
          tracks: [],
        },
      ],
    }) +
    ';';
  const fixture = original.slice(0, start) + initial + original.slice(end);
  await writeFile(`${root}/animation.ts`, fixture);
  const pins = JSON.parse(await readFile(`${source}/editor-pin.json`));
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['animation.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: 'dist',
    metafile: true,
    define: { EDITOR_PINS: JSON.stringify(pins.packages) },
  });
  const unexpectedInputs = Object.keys(result.metafile.inputs).filter((name) => {
    const resolved = path.resolve(root, name);
    return (
      !resolved.startsWith(root + path.sep) &&
      !resolved.startsWith(path.join(source, 'node_modules') + path.sep)
    );
  });
  if (unexpectedInputs.length)
    throw Error('Unexpected noninstalled build inputs: ' + unexpectedInputs.join(', '));
  const html = (await readFile(`${source}/dist/animation.html`, 'utf8')).replace(
    '<body>',
    '<body><p>QA ONLY: empty artifact supplied through existing public embedding API. Installed Host has no New/empty UI.</p>',
  );
  await writeFile(`${root}/dist/animation.html`, html);
  await writeFile(`${root}/build-inputs.json`, JSON.stringify(result.metafile, null, 2));
  await writeFile(
    `${root}/empty-fixture-provenance.json`,
    JSON.stringify(
      {
        sourceCommit: pins.sourceCommit,
        sourceAnimationSha256: createHash('sha256').update(original).digest('hex'),
        fixtureAnimationSha256: createHash('sha256').update(fixture).digest('hex'),
        change:
          'Only initial native replaced with layers:[], tracks:[]; installed packages unchanged; public embedding harness, not installed Host New UI',
        packages: pins.packages,
      },
      null,
      2,
    ),
  );
  console.log(kind, root);
}
