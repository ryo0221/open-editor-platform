import { build } from 'esbuild';
import { buildAnimationRuntimePin } from './animation-runtime-pin.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { publishAnimationExport } from './animation-export-directory.mjs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
const runtimePin = await buildAnimationRuntimePin();
const repo = fileURLToPath(new URL('../', import.meta.url)),
  input = process.argv[2];
if (!input) throw Error('Usage: node scripts/animation-react-export-host.mjs saved-animation.json');
const model = await build({
  stdin: {
    contents:
      'export {createAnimationReactDocument,animationReactResolution} from "./apps/animation-reference/src/react-registration"; export {readAnimationHostArtifact,savedAnimationEmbed} from "./apps/animation-reference/src/model"; export {exportReactUi} from "@editor-platform/react-ui-core";',
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [
    {
      name: 'trusted-raw-source',
      setup(builder) {
        builder.onResolve({ filter: /^virtual:animation-runtime-pin$/ }, () => ({
          path: 'animation-runtime-pin',
          namespace: 'runtime-pin',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'runtime-pin' }, () => ({
          contents: 'export default ' + JSON.stringify(runtimePin),
          loader: 'js',
        }));
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: 'raw',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
          contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`,
          loader: 'js',
        }));
      },
    },
  ],
});
const {
  createAnimationReactDocument,
  animationReactResolution,
  readAnimationHostArtifact,
  savedAnimationEmbed,
  exportReactUi,
} = await import(
  `data:text/javascript;base64,${Buffer.from(model.outputFiles[0].text).toString('base64')}`
);
const artifact = await readAnimationHostArtifact(await readFile(input, 'utf8')),
  embed = savedAnimationEmbed(artifact);
if (!embed) throw Error('Save an immutable Animation version before export');
const document = createAnimationReactDocument(embed),
  bundle = exportReactUi(document, animationReactResolution),
  exportRoot = path.join(repo, 'work/issue74-2d/react-export'),
  out = path.join(exportRoot, '.building-' + randomUUID());
await mkdir(path.join(out, 'generated'), { recursive: true });
for (const [name, value] of Object.entries(bundle.files))
  await writeFile(path.join(out, 'generated', name), value);
await writeFile(
  path.join(out, 'entry.tsx'),
  `import React from 'react';import{createRoot}from'react-dom/client';import Screen from './generated/Screen';createRoot(document.getElementById('root')!).render(<Screen/>);`,
);
await build({
  absWorkingDir: out,
  entryPoints: ['entry.tsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: path.join(out, 'runtime.js'),
  alias: {
    '@animation-reference/player': path.join(
      repo,
      'apps/animation-reference/src/registered-player.tsx',
    ),
  },
});
await writeFile(
  path.join(out, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="runtime.css"></head><body><div id="root"></div><script src="runtime.js"></script></body></html>',
);
await writeFile(
  path.join(out, 'handoff.json'),
  JSON.stringify(
    {
      source: embed.source,
      evaluator: embed.evaluatorVersion,
      player: embed.playerVersion,
      environment: document.environment.ref,
      components: document.components.map((c) => c.ref),
    },
    null,
    2,
  ),
);
const finalPath = await publishAnimationExport(
  out,
  exportRoot,
  embed.source.contentHash.slice(0, 16) + '-' + document.environment.ref.hash.slice(0, 8),
);
process.stdout.write(finalPath + '\n');
