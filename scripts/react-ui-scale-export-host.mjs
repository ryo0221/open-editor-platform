import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { loadReactScaleApi } from './react-ui-scale-fixture.mjs';

const [mode = 'prepare', output = 'work/complete24/independent'] = process.argv.slice(2);
const target = path.resolve(output);
await mkdir(target, { recursive: true });
const fixtureBytes = await readFile('work/complete24/fixture.json');
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
if (mode === 'prepare') {
  const api = await loadReactScaleApi(path.resolve('work/complete24/export-driver'));
  const document = api.parseReactUiDocument(fixtureBytes.toString());
  const bundle = api.exportReactUi(document, api.scaleResolution);
  assert.match(bundle.files['Screen.tsx'], /from "@scale\/ui"/);
  assert.doesNotMatch(bundle.files['Screen.tsx'], /@editor-platform|data-react-ui-node/);
  await mkdir(path.join(target, 'generated/styles'), { recursive: true });
  await mkdir(path.join(target, 'generated/assets'), { recursive: true });
  await mkdir(path.join(target, 'public/assets'), { recursive: true });
  for (const [file, contents] of Object.entries(bundle.files))
    await writeFile(path.join(target, 'generated', file), contents);
  await copyFile(
    'tests/fixtures/react-ui-scale/components.tsx',
    path.join(target, 'components.tsx'),
  );
  await copyFile(
    'tests/fixtures/react-ui-scale/styles.css',
    path.join(target, 'generated/styles/scale.css'),
  );
  await copyFile(
    'tests/fixtures/office/images/quadrants.png',
    path.join(target, 'generated/assets/scale.png'),
  );
  await copyFile(
    'tests/fixtures/office/images/quadrants.png',
    path.join(target, 'public/assets/scale.png'),
  );
  const version = async (name) =>
    JSON.parse(await readFile(path.join('node_modules', name, 'package.json'), 'utf8')).version;
  await writeFile(
    path.join(target, 'package.json'),
    JSON.stringify(
      {
        name: 'issue24-independent-scale',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: { preview: 'vite preview' },
        dependencies: { react: await version('react'), 'react-dom': await version('react-dom') },
        devDependencies: Object.fromEntries(
          await Promise.all(
            ['typescript', 'vite', '@types/react', '@types/react-dom', '@types/node'].map(
              async (name) => [name, await version(name)],
            ),
          ),
        ),
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(target, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          baseUrl: '.',
          paths: { '@scale/ui': ['./components.tsx'] },
        },
        include: ['components.tsx', 'src.tsx', 'generated/Screen.tsx', 'env.d.ts'],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(target, 'env.d.ts'),
    'declare module "*.png" { const url: string; export default url; }\n',
  );
  await writeFile(
    path.join(target, 'vite.config.ts'),
    `import {defineConfig} from 'vite';\nimport {fileURLToPath,URL} from 'node:url';\nexport default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),resolve:{alias:{'@scale/ui':fileURLToPath(new URL('./components.tsx',import.meta.url))}},build:{rollupOptions:{treeshake:false}}});\n`,
  );
  await writeFile(
    path.join(target, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"><link rel="icon" href="data:,"><title>Independent React-only scale screen</title></head><body><div id="root"></div><script type="module" src="/src.tsx"></script></body></html>',
  );
  await writeFile(
    path.join(target, 'src.tsx'),
    `import {useState} from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {Screen} from './generated/Screen';\nfunction App(){const[name,setName]=useState('');const[count,setCount]=useState(0);return <><Screen name={name} onNameChange={setName} onAction={()=>setCount(value=>value+1)}/><output aria-label="Application name">{name}</output><output aria-label="Application callbacks">{count}</output></>;}\ncreateRoot(document.getElementById('root')!).render(<App/>);\n`,
  );
  const install = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: target,
    encoding: 'utf8',
  });
  await writeFile(path.join(target, 'install.log'), install.stdout + install.stderr);
  assert.equal(install.status, 0, install.stderr);
  await writeFile(
    path.join(target, 'fixture-identity.json'),
    JSON.stringify(
      {
        fixtureSha256,
        nodes: document.nodes.length,
        components: document.components.length,
        implementationSha256: createHash('sha256')
          .update(await readFile(path.join(target, 'components.tsx')))
          .digest('hex'),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      prepared: target,
      fixtureSha256,
      dependencies: JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
        .dependencies,
    }),
  );
} else if (mode === 'verify' || mode === 'run') {
  // Verify the previously prepared standalone app against the current public
  // exporter before timing its own processes. It has no Editor dependency.
  const api = await loadReactScaleApi(path.resolve('work/complete24/export-driver'));
  const document = api.parseReactUiDocument(fixtureBytes.toString());
  const bundle = api.exportReactUi(document, api.scaleResolution);
  for (const [file, contents] of Object.entries(bundle.files))
    assert.equal(await readFile(path.join(target, 'generated', file), 'utf8'), contents, file);
  for (const [original, copy] of [
    ['tests/fixtures/react-ui-scale/components.tsx', 'components.tsx'],
    ['tests/fixtures/react-ui-scale/styles.css', 'generated/styles/scale.css'],
    ['tests/fixtures/office/images/quadrants.png', 'generated/assets/scale.png'],
  ])
    assert.deepEqual(await readFile(path.join(target, copy)), await readFile(original), copy);
  const identity = JSON.parse(await readFile(path.join(target, 'fixture-identity.json'), 'utf8'));
  assert.equal(identity.fixtureSha256, fixtureSha256);
  assert.equal(identity.nodes, 500);
  assert.equal(identity.components, 21);
  const dependencies = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(dependencies.dependencies).sort(), ['react', 'react-dom']);
  if (mode === 'verify') {
    console.log(
      JSON.stringify({ verified: true, fixtureSha256, files: Object.keys(bundle.files) }),
    );
  } else {
    const metrics = [];
    for (const [name, command, args, budgetMs, targetMs] of [
      ['typecheck', 'typescript/bin/tsc', ['--noEmit'], 10000, 5000],
      ['production-build', 'vite/bin/vite.js', ['build'], 15000, 7500],
    ]) {
      const samples = [];
      for (let repetition = 1; repetition <= 3; repetition++) {
        const start = performance.now();
        const result = spawnSync(
          process.execPath,
          [path.join(target, 'node_modules', command), ...args],
          { cwd: target, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        );
        const ms = performance.now() - start;
        await writeFile(
          path.join(target, `${name}-${repetition}.log`),
          result.stdout + result.stderr,
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        samples.push(ms);
      }
      metrics.push({
        name,
        budgetMs,
        targetMs,
        statistic: 'maximum',
        samples,
        maxMs: Math.max(...samples),
      });
    }
    const report = {
      kind: 'independent',
      fixtureSha256,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      measuredAt: new Date().toISOString(),
      node: process.version,
      metrics,
    };
    await writeFile(path.join(target, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.exitCode = Number(metrics.some((metric) => metric.maxMs > metric.budgetMs));
  }
} else throw Error('Expected prepare, verify or run');
