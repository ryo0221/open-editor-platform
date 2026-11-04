/** Local packaged-export correctness check; no release, browser, server or performance workload. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || !relative(root, output).startsWith('..') || existsSync(output))
  throw Error('Pass a new directory outside the checkout');
mkdirSync(output, { recursive: true });
const env = { ...process.env, npm_config_cache: resolve(output, 'npm-cache') };
const pack = JSON.parse(
  execFileSync(
    'npm',
    ['pack', './packages/fiction-map', '--ignore-scripts', '--json', '--pack-destination', output],
    { cwd: root, env, encoding: 'utf8' },
  ),
)[0];
const directory = resolve(output, 'node_modules/@editor-platform/fiction-map');
mkdirSync(directory, { recursive: true });
execFileSync('tar', [
  '-xf',
  resolve(output, pack.filename),
  '-C',
  directory,
  '--strip-components=1',
]);
const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
if (manifest.exports['./model'] !== './src/model.ts') throw Error('Unexpected public export');
const source = `
import assert from 'node:assert/strict';
import * as M from '@editor-platform/fiction-map/model';
import {EditorSession} from '@editor-platform/editor-core';
assert.equal(typeof document,'undefined');assert.equal(typeof window,'undefined');
const unwrap=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const content=M.createFictionMap(),session=new EditorSession(content);
const base={content,revision:session.revision};
const p=unwrap(M.prepareFictionMapChange(base,{layers:[{id:'l',name:'Places',purpose:'settlement',visibleByDefault:true}],create:[{id:'p',layerId:'l',featureKind:'place',name:'Town',geometry:{type:'point',coordinates:[180,90]},worldEntityRef:{namespace:'world',entityId:'opaque'}}]}));
assert.equal(M.commitFictionMapChange(session,p,()=>false).diagnostic.code,'permission-denied');assert.equal(session.revision.sequence,0);
const next=unwrap(M.commitFictionMapChange(session,p,()=>true));assert.equal(next.changed,true);assert.equal(session.revision.sequence,1);
assert.deepEqual(unwrap(M.parseFictionMap(unwrap(M.serializeFictionMap(next.content)))),next.content);
assert.equal(unwrap(M.hitTestFictionMapGeometry(next.content.features[0].geometry,[180,90],0)),true);
assert.equal(unwrap(M.undoFictionMap(session,()=>true)).content.features.length,0);
assert.equal(unwrap(M.redoFictionMap(session,()=>true)).content.features[0].id,'p');
assert.equal(M.commitFictionMapChange(session,p,()=>true).diagnostic.code,'prepared-consumed');
assert.equal('admit' in M,false);assert.equal('checkGeometry' in M,false);
console.log(JSON.stringify({status:'PASS',runtime:'node-headless',exports:Object.keys(M).sort(),revision:session.revision.sequence}));
`;
const bundle = resolve(output, 'smoke.mjs');
const result = await build({
  stdin: { contents: source, loader: 'js', resolveDir: output },
  nodePaths: [resolve(root, 'node_modules')],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  external: ['node:*'],
  outfile: bundle,
  metafile: true,
});
const inputs = Object.keys(result.metafile.inputs);
if (
  inputs.some((p) =>
    /(?:^|\/)node_modules\/(?:react|react-dom)(?:\/|$)|packages\/(?:canvas|geo-|design|cad|bim)/u.test(
      p,
    ),
  )
)
  throw Error('Forbidden domain/runtime dependency');
const hashes = Object.fromEntries(
  inputs
    .filter((p) => !p.includes('<stdin>'))
    .map((p) => {
      const file = resolve(p);
      return [file, createHash('sha256').update(readFileSync(file)).digest('hex')];
    }),
);
writeFileSync(
  resolve(output, 'runtime-source.json'),
  JSON.stringify({ pack: pack.filename, inputs: hashes }, null, 2) + '\n',
);
const log = execFileSync(process.execPath, [bundle], { cwd: output, encoding: 'utf8' });
writeFileSync(resolve(output, 'smoke.log'), log);
process.stdout.write(log);
