import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import console from 'node:console';
const repo = fileURLToPath(new URL('../', import.meta.url));
const screen = process.argv[2] ?? 'unbound';
if (!['unbound', 'product', 'form', 'revised'].includes(screen))
  throw new Error('Expected unbound/product/form/revised');
// Fixed reference sources, never arbitrary uploaded code or packages.
const result = await build({
  stdin: {
    contents:
      'export { createReferenceDocument, referenceResolutionFor, referenceTextRevision, referenceEnvironmentRevision } from "./apps/react-ui-reference/src/catalog"; export { exportReactUi, prepareReactUiRevision } from "@editor-platform/react-ui-core";',
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [
    {
      name: 'reference-evidence',
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
const {
  createReferenceDocument,
  referenceResolutionFor,
  referenceTextRevision,
  referenceEnvironmentRevision,
  exportReactUi,
  prepareReactUiRevision,
} = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);
let document = createReferenceDocument(screen === 'revised' ? 'form' : screen);
if (screen === 'revised') {
  document = prepareReactUiRevision(document, {
    component: referenceTextRevision,
    nodeIds: ['title', 'footer'],
    propMap: { text: 'content' },
    slotMap: {},
    environment: referenceEnvironmentRevision,
  }).command.apply(document);
}
const bundle = exportReactUi(document, referenceResolutionFor(document.environment.ref));
const target = path.join(repo, 'work/issue-24/export-host', screen);
await mkdir(path.join(target, 'generated/styles'), { recursive: true });
await mkdir(path.join(target, 'generated/assets'), { recursive: true });
for (const [name, value] of Object.entries(bundle.files))
  await writeFile(path.join(target, 'generated', name), value);
await copyFile(
  path.join(repo, 'apps/react-ui-reference/public/styles/tokens.css'),
  path.join(target, 'generated/styles/tokens.css'),
);
await copyFile(
  path.join(repo, 'tests/fixtures/office/images/quadrants.png'),
  path.join(target, 'generated/assets/product.png'),
);
await copyFile(
  path.join(repo, 'apps/react-ui-reference/src/components.tsx'),
  path.join(target, 'ui.tsx'),
);
await writeFile(
  path.join(target, 'package.json'),
  JSON.stringify(
    {
      private: true,
      type: 'module',
      dependencies: { react: '19.1.1', 'react-dom': '19.1.1' },
      scripts: { build: 'vite build' },
    },
    null,
    2,
  ),
);
await writeFile(
  path.join(target, 'index.html'),
  '<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/App.tsx"></script></body></html>',
);
const app =
  screen === 'unbound'
    ? '<Screen />'
    : '<Screen title={title} name={name} onNameChange={setName} onBuy={() => { setCount(c => c + 1); setTitle("Thanks " + (name || "visitor")); }} />';
await writeFile(
  path.join(target, 'App.tsx'),
  `import { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { Screen } from './generated/Screen'; function App() { const [title,setTitle]=useState(${JSON.stringify(['form', 'revised'].includes(screen) ? 'Contact us' : 'Color study')}); const [name,setName]=useState(''); const [count,setCount]=useState(0); return <>${app}<p id="app-status" aria-live="polite">{count ? 'Submitted '+count : ''}</p></>; } createRoot(document.getElementById('root')!).render(<App />);`,
);
await writeFile(
  path.join(target, 'assets.d.ts'),
  'declare module "*.png" { const url: string; export default url; }',
);
await copyFile(
  path.join(repo, 'apps/react-ui-reference/src/components-v2.tsx'),
  path.join(target, 'ui-v2.tsx'),
);
await writeFile(
  path.join(target, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      jsx: 'react-jsx',
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      baseUrl: '.',
      paths: { '@reference/ui': ['./ui.tsx'], '@reference/ui-revision': ['./ui-v2.tsx'] },
    },
    include: ['*.tsx', '*.d.ts', 'generated/*.tsx'],
  }),
);
await writeFile(
  path.join(target, 'vite.config.mjs'),
  `export default { base: './', root: ${JSON.stringify(target)}, esbuild: { jsx: 'automatic' }, resolve: { alias: { '@reference/ui-revision': ${JSON.stringify(path.join(target, 'ui-v2.tsx'))}, '@reference/ui': ${JSON.stringify(path.join(target, 'ui.tsx'))} } }, build: { rollupOptions: { treeshake: false }, outDir: 'dist', emptyOutDir: true } };`,
);
for (const args of [
  ['tsc', '-p', path.join(target, 'tsconfig.json')],
  ['vite', 'build', '--config', path.join(target, 'vite.config.mjs')],
]) {
  const run = spawnSync(path.join(repo, 'node_modules/.bin', args[0]), args.slice(1), {
    cwd: target,
    stdio: 'inherit',
    env: process.env,
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
console.log(`Independent ${screen} host built at ${target}; fingerprint ${bundle.fingerprint}`);
