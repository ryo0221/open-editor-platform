import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { unzipSync, strFromU8 } from 'fflate';
import console from 'node:console';
const repo = fileURLToPath(new URL('../', import.meta.url));
const zip = process.argv[2];
if (!zip) throw new Error('Supply a ZIP downloaded from the ordinary Design UI');
const files = unzipSync(new Uint8Array(await readFile(zip)));
const target = path.join(repo, 'work/issue-29/independent-host');
await rm(path.join(target, 'generated'), { recursive: true, force: true });
await mkdir(path.join(target, 'generated'), { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  if (
    !/^[A-Za-z0-9_./-]+$/.test(name) ||
    name.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error('Unsafe generated bundle path');
  const file = path.join(target, 'generated', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
const manifest = JSON.parse(strFromU8(files['manifest.json']));
if (manifest.ownership !== 'generated-directory-only')
  throw new Error('Expected reviewed native Design bundle');
for (const [source, dest] of [
  ['components.tsx', 'ui.tsx'],
  ['components-v2.tsx', 'ui-v2.tsx'],
])
  await copyFile(path.join(repo, 'apps/react-ui-reference/src', source), path.join(target, dest));
await writeFile(
  path.join(target, 'index.html'),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>html,html body,#root{margin:0;padding:0;min-height:100%;}*{box-sizing:border-box;}</style></head><body><div id="root"></div><script type="module" src="/App.tsx"></script></body></html>',
);
await writeFile(
  path.join(target, 'App.tsx'),
  `import {useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {Site} from './generated/Site';function App(){const [title,setTitle]=useState('Color study');const [name,setName]=useState('');const [count,setCount]=useState(0);const [path,setPath]=useState(location.pathname);useEffect(()=>{const pop=()=>setPath(location.pathname);window.addEventListener('popstate',pop);const navigate=(e:MouseEvent)=>{const a=(e.target as HTMLElement).closest('a');if(a?.getAttribute('href')?.startsWith('/')){e.preventDefault();history.pushState(null,'',a.getAttribute('href'));setPath(location.pathname);}};document.addEventListener('click',navigate);return()=>{window.removeEventListener('popstate',pop);document.removeEventListener('click',navigate);};},[]);return <><Site path={path} title={title} name={name} onNameChange={setName} onBuy={()=>{setCount(c=>c+1);setTitle('Thanks '+(name||'visitor'));}}/><p id="app-status">{count?'Submitted '+count:''}</p></>;}createRoot(document.getElementById('root')!).render(<App/>);`,
);
await writeFile(
  path.join(target, 'assets.d.ts'),
  'declare module "*.png" {const url:string;export default url;}',
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
    include: ['*.tsx', '*.d.ts', 'generated/**/*.tsx'],
  }),
);
await writeFile(
  path.join(target, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { react: '19.1.1', 'react-dom': '19.1.1' },
    scripts: { build: 'vite build' },
  }),
);
await writeFile(
  path.join(target, 'vite.config.mjs'),
  `export default {base:'/',root:${JSON.stringify(target)},esbuild:{jsx:'automatic'},resolve:{alias:{'@reference/ui-revision':${JSON.stringify(path.join(target, 'ui-v2.tsx'))},'@reference/ui':${JSON.stringify(path.join(target, 'ui.tsx'))}}},build:{rollupOptions:{treeshake:false},outDir:'dist',emptyOutDir:true}};`,
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
console.log(
  'Independent native-Design React Host built. No Editor packages or original source modifications in generated application.',
);
