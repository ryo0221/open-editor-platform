import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import console from 'node:console';
import { TextEncoder } from 'node:util';
import { createHash } from 'node:crypto';
const repo = fileURLToPath(new URL('../', import.meta.url));
const screen = process.argv[2] ?? 'unbound';
if (!['unbound', 'product', 'form', 'revised', 'portable'].includes(screen))
  throw new Error('Expected unbound/product/form/revised/portable');
// Fixed reference sources, never arbitrary uploaded code or packages.
const result = await build({
  stdin: {
    contents:
      'export { createReferenceDocument, referenceResolutionFor, referenceTextRevision, referenceEnvironmentRevision } from "./apps/react-ui-reference/src/catalog"; export { exportReactUi, prepareReactUiRevision, sealReactEnvironment, loadReactUiDocument } from "@editor-platform/react-ui-core"; export { createArtifact, commitVersion, deserializeArtifact, contentHash } from "@editor-platform/artifact-core"; export { createArtifactOutputManifest, verifyArtifactOutputManifest } from "@editor-platform/artifact-output";',
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
  createArtifact,
  commitVersion,
  deserializeArtifact,
  contentHash,
  createArtifactOutputManifest,
  verifyArtifactOutputManifest,
  sealReactEnvironment,
  loadReactUiDocument,
} = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);
let document = createReferenceDocument(['revised', 'portable'].includes(screen) ? 'form' : screen);
if (screen === 'revised') {
  document = prepareReactUiRevision(document, {
    component: referenceTextRevision,
    nodeIds: ['title', 'footer'],
    propMap: { text: 'content' },
    slotMap: {},
    environment: referenceEnvironmentRevision,
  }).command.apply(document);
}
const target = path.join(repo, 'work/issue-24/export-host', screen);
await mkdir(path.join(target, 'generated/styles'), { recursive: true });
await mkdir(path.join(target, 'generated/assets'), { recursive: true });
if (screen === 'portable') {
  const file = path.join(repo, 'tests/fixtures/react-ui/portability-host.tsx');
  // Only this fixed trusted Host fixture is read; the tooling receives a Host-provided hash.
  const implementationHash = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  const requestFile = path.join(target, 'registration-request.json');
  await writeFile(
    requestFile,
    JSON.stringify({
      sourceRevision: implementationHash,
      entries: [
        {
          file,
          exportName: 'Panel',
          ref: {
            registryId: 'portable-host',
            componentId: 'Panel',
            version: '1.0.0',
            implementationHash,
          },
          import: { source: '@portable/ui', export: 'named', name: 'Panel' },
          requires: ['portable-ui'],
        },
      ],
      policies: {
        '["portable-host","Panel"]': { layout: 'wrapper', sampleProps: { title: 'Portable page' } },
      },
    }),
  );
  const extraction = spawnSync(process.execPath, ['scripts/react-ui-register.mjs', requestFile], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (extraction.status !== 0)
    throw Error('Portable Host extraction failed: ' + extraction.stderr + extraction.stdout);
  const extracted = JSON.parse(extraction.stdout);
  if (extracted.diagnostics.length || extracted.candidates.length !== 1)
    throw Error('Portable Host registration failed');
  const component = extracted.candidates[0];
  const environment = sealReactEnvironment({
    schemaVersion: 1,
    ref: { id: 'portable-host', version: '1.0.0' },
    reactVersion: '19.1.1',
    dependencies: [
      {
        id: 'portable-ui',
        kind: 'package',
        name: '@portable/ui',
        version: '1.0.0',
        hash: implementationHash,
      },
    ],
    providerOrder: [],
    stylePolicy: 'allow-literals',
    tokenVariables: {},
  });
  document = loadReactUiDocument({
    schemaVersion: 1,
    domain: 'react-ui',
    environment,
    components: [component],
    inputs: { title: component.props.title },
    callbacks: { onPick: component.events.onPick },
    fixture: { title: 'Portable page' },
    breakpoints: [{ id: 'desktop', minWidth: 1024 }],
    roots: ['panel'],
    nodes: [
      {
        id: 'panel',
        component: component.ref,
        props: {},
        bindings: {
          title: { kind: 'data', input: 'title', path: [] },
          onPick: { kind: 'callback', callback: 'onPick' },
        },
        slots: { body: [], action: [] },
        layout: {
          base: {
            padding: { kind: 'literal', value: 16 },
            fontFamily: { kind: 'literal', value: 'Arial' },
          },
          breakpoints: {},
        },
      },
    ],
  });
}
const resolution =
  screen === 'portable'
    ? {
        environment: document.environment.ref,
        components: document.components.map((c) => c.ref),
        dependencies: document.environment.dependencies.map((d) => ({ id: d.id, hash: d.hash })),
      }
    : referenceResolutionFor(document.environment.ref);
const bundle = exportReactUi(document, resolution);
// Host explicitly owns source persistence; re-use its immutable pin across repeated exports.
const sourceFile = path.join(target, 'source-artifact.json');
let artifact;
try {
  artifact = deserializeArtifact(await readFile(sourceFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!artifact || artifact.versions.at(-1)?.contentHash !== (await contentHash(document))) {
  artifact = artifact
    ? { ...artifact, draft: { ...artifact.draft, content: document } }
    : createArtifact('react-ui', screen, document);
  artifact = await commitVersion(artifact, 'reference-host', 'Explicit output handoff');
  await writeFile(sourceFile, JSON.stringify(artifact));
}
const saved = artifact.versions.at(-1);
const outputFiles = Object.entries(bundle.files).map(([name, text]) => ({
  path: 'generated/' + name,
  mediaType: name.endsWith('.json')
    ? 'application/json'
    : name.endsWith('.css')
      ? 'text/css'
      : 'text/plain',
  bytes: new TextEncoder().encode(text),
}));
const pins = document.environment.dependencies.map((dep) => ({
  id: 'dependency/' + dep.id,
  version: dep.kind === 'package' ? dep.version : document.environment.ref.version,
  hash: dep.hash,
}));
for (const component of document.components)
  pins.push({
    id:
      'component/' +
      component.ref.registryId +
      '/' +
      component.ref.componentId +
      '/' +
      component.ref.version,
    version: component.ref.version,
    hash: component.ref.implementationHash,
  });
pins.push({
  id: 'environment/' + document.environment.ref.id,
  version: document.environment.ref.version,
  hash: document.environment.ref.hash,
});
const outputManifest = await createArtifactOutputManifest(
  artifact,
  saved.versionId,
  bundle.generator,
  outputFiles,
  pins,
);
await verifyArtifactOutputManifest(outputManifest, outputFiles, outputManifest);
await writeFile(path.join(target, 'artifact-output.json'), JSON.stringify(outputManifest, null, 2));
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
  path.join(
    repo,
    screen === 'portable'
      ? 'tests/fixtures/react-ui/portability-host.tsx'
      : 'apps/react-ui-reference/src/components.tsx',
  ),
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
  screen === 'portable'
    ? '<Screen title={title} onPick={choice => setTitle("Picked " + choice)} />'
    : screen === 'unbound'
      ? '<Screen />'
      : '<Screen title={title} name={name} onNameChange={setName} onBuy={() => { setCount(c => c + 1); setTitle("Thanks " + (name || "visitor")); }} />';
await writeFile(
  path.join(target, 'App.tsx'),
  `import { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { Screen } from './generated/Screen'; function App() { const [title,setTitle]=useState(${JSON.stringify(screen === 'portable' ? 'Portable page' : ['form', 'revised'].includes(screen) ? 'Contact us' : 'Color study')}); const [name,setName]=useState(''); const [count,setCount]=useState(0); return <>${app}<p id="app-status" aria-live="polite">{count ? 'Submitted '+count : ''}</p></>; } createRoot(document.getElementById('root')!).render(<App />);`,
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
      paths: {
        '@reference/ui': ['./ui.tsx'],
        '@portable/ui': ['./ui.tsx'],
        '@reference/ui-revision': ['./ui-v2.tsx'],
      },
    },
    include: ['*.tsx', '*.d.ts', 'generated/*.tsx'],
  }),
);
await writeFile(
  path.join(target, 'vite.config.mjs'),
  `export default { base: './', root: ${JSON.stringify(target)}, esbuild: { jsx: 'automatic' }, resolve: { alias: { '@reference/ui-revision': ${JSON.stringify(path.join(target, 'ui-v2.tsx'))}, '@reference/ui': ${JSON.stringify(path.join(target, 'ui.tsx'))}, '@portable/ui': ${JSON.stringify(path.join(target, 'ui.tsx'))} } }, build: { outDir: 'dist', emptyOutDir: true } };`,
);
for (const args of [
  ['tsc', '-p', path.join(target, 'tsconfig.json')],
  ['vite', 'build', '--config', path.join(target, 'vite.config.mjs')],
]) {
  const run = spawnSync(path.join(repo, 'node_modules/.bin', args[0]), args.slice(1), {
    cwd: target,
    stdio: 'inherit',
    env: process.env,
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  if (run.error)
    throw Error(
      `Independent ${screen} ${args[0]} failed: ${run.error.code}; signal=${run.signal ?? 'none'}`,
    );
  if (run.status !== 0) process.exit(run.status ?? 1);
}
console.log(`Independent ${screen} host built at ${target}; fingerprint ${bundle.fingerprint}`);
