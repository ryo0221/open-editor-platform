import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export async function loadReactScaleApi(output) {
  await mkdir(output, { recursive: true });
  const result = await build({
    stdin: {
      contents: [
        'export * from "./tests/fixtures/react-ui-scale/catalog";',
        'export * from "@editor-platform/react-ui-core";',
        'export { EditorSession } from "@editor-platform/editor-core";',
        'export { reuseHash } from "@editor-platform/reuse-core";',
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'pinned-scale-source',
        setup(builder) {
          builder.onResolve({ filter: /\?(raw|inline)$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.replace(/\?(raw|inline)$/, '')),
            namespace: args.path.endsWith('?raw') ? 'raw' : 'inline',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
            contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`,
            loader: 'js',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'inline' }, async (args) => ({
            contents: `export default ${JSON.stringify('data:image/png;base64,' + (await readFile(args.path)).toString('base64'))}`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const file = path.resolve(output, 'api.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
