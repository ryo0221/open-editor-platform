// Local-only verification kit. Never publishes or downloads runtime code.
import { build } from 'esbuild';
import { packThirdParty } from './third-party.mjs';
import ts from 'typescript';
import {
  pinnedSource,
  digest as sha256,
  dependencyClosure,
  auditTypeImports,
  checkPublicImport,
} from './source.mjs';
import { cp, mkdir, readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const sourceCommit = process.argv[3];
const source = pinnedSource(repo, sourceCommit);
const output = path.resolve(process.argv[2] ?? '/tmp/editor-extension-packaging');
await mkdir(path.dirname(output), { recursive: true });
const parent = await realpath(path.dirname(output));
if (parent === repo || parent.startsWith(repo + path.sep))
  throw new Error('Output must be outside checkout');
// An existing output is deliberately not overwritten or deleted.
await mkdir(output);
const run = (command, args, cwd = repo) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
if (run('git', ['status', '--porcelain']).trim())
  throw new Error('Commit kit changes before recording exact provenance');
const profile = process.argv[4] ?? 'baseline';
if (!['baseline', 'readonly-domains', 'controlled-animation'].includes(profile))
  throw Error('Unknown packaging profile');
const names = [
  'artifact-core',
  'editor-core',
  'extension-contract',
  'extension-runtime',
  'animation-core',
  'animation-player',
  'extension-sample',
  ...(profile !== 'baseline' ? ['video-core', 'video-metadata', 'geo-core', 'geo-inspector'] : []),
];
if (profile === 'controlled-animation') names.push('animation', 'extension-animation-adapter');
const manifests = new Map(
  await Promise.all(
    names.map(async (name) => {
      const manifest = JSON.parse(source.read(`packages/${name}/package.json`).toString());
      return [manifest.name, manifest];
    }),
  ),
);
const notice =
  'Local trusted-code verification artifact; not published. No root LICENSE exists in this checkout. No distribution permission or license exception is inferred. See unchanged EDITOR-EXTENSION-INTERFACE-SCOPE.md and runtime manifest notices.\n';
const kitFiles = ['verify.mjs', 'host.mjs', 'host-types.ts', 'browser.ts'];
const evidence = {
  sourceCommit,
  profile,
  builderCommit: run('git', ['rev-parse', 'HEAD']).trim(),
  kitSourceFiles: Object.fromEntries(
    kitFiles.map((name) => [
      'scripts/extension-packaging/' + name,
      sha256(source.read('scripts/extension-packaging/' + name)),
    ]),
  ),
  runtime: '1.0.0-draft.2',
  node: process.version,
  typescript: ts.version,
  sourceNoticeHash: sha256(source.read('EDITOR-EXTENSION-INTERFACE-SCOPE.md')),
  packages: [],
  phases: ['platform', 'extension-sample'],
  thirdParty: [],
  sourceLockHash: sha256(source.read('package-lock.json')),
  notice,
};
await mkdir(path.join(output, 'tarballs'));
const thirdParty =
  profile === 'controlled-animation' ? await packThirdParty(repo, output, source) : [];
for (const item of thirdParty) {
  manifests.set(item.name, {
    ...item.manifest,
    exports: item.manifest.exports ?? { '.': item.manifest.main ?? './index.js' },
  });
  const record = { ...item };
  delete record.directory;
  evidence.thirdParty.push(record);
}
const built = path.join(output, 'built');
await mkdir(built);
async function inventory(dir, prefix = '') {
  const result = {};
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory())
      Object.assign(result, await inventory(path.join(dir, item.name), name + '/'));
    else result[name] = sha256(await readFile(path.join(dir, item.name)));
  }
  return result;
}
for (const name of names) {
  const manifest = manifests.get('@editor-platform/' + name);
  const stage = path.join(output, 'build-' + name);
  const pkg = path.join(built, name);
  await mkdir(stage);
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest));
  await mkdir(pkg);
  const sourceFiles = await source.stage(`packages/${name}/src`, path.join(stage, 'src'));
  sourceFiles[`packages/${name}/package.json`] = sha256(
    source.read(`packages/${name}/package.json`),
  );
  for (const file of Object.keys(sourceFiles).filter((file) => /\.tsx?$/.test(file))) {
    auditTypeImports(
      source.read(file).toString(),
      file,
      manifest,
      manifests,
      `packages/${name}/src`,
    );
  }
  const dependencies = {};
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const known = manifests.get(dependency);
    if (!known) throw new Error('Non-reviewed dependency: ' + dependency);
    dependencies[dependency] = known.version;
  }
  // Only the declared transitive closure is visible to the declaration compiler.
  const closure = dependencyClosure(manifest, manifests);
  const typeDependencies =
    profile === 'controlled-animation' &&
    (manifest.dependencies?.react || manifest.dependencies?.['react-dom'])
      ? ['csstype', '@types/react', '@types/react-dom']
      : [];
  for (const dependency of typeDependencies)
    if (!closure.includes(dependency)) closure.push(dependency);
  for (const dependency of closure) {
    const previous = evidence.packages.find((pkg) => pkg.name === dependency);
    const external = thirdParty.find((item) => item.name === dependency);
    if (!previous && !external) throw new Error('Dependency must be built first: ' + dependency);
    await cp(
      external?.directory ?? path.join(built, previous.name.split('/')[1]),
      path.join(stage, 'node_modules', dependency),
      { recursive: true },
    );
  }
  const entryPoints = Object.fromEntries(
    Object.entries(manifest.exports)
      .filter(([, value]) => /\.tsx?$/.test(value))
      .map(([key, value]) => [key === '.' ? 'index' : key.slice(2), path.join(stage, value)]),
  );
  const exported = {};
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (value.endsWith('.css')) {
      exported[key] = './dist/' + path.basename(value);
      continue;
    }
    exported[key] = {
      types: './types/' + value.replace('./src/', '').replace(/\.tsx?$/, '.d.ts'),
      import: './dist/' + (key === '.' ? 'index' : key.slice(2)) + '.js',
    };
  }
  // Types resolve exclusively against already built package declarations in this stage.
  const program = ts.createProgram(Object.values(entryPoints), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    skipLibCheck: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: path.join(stage, 'src'),
    outDir: path.join(pkg, 'types'),
    types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => stage,
        getNewLine: () => '\n',
      }),
    );
  if (program.emit().emitSkipped) throw new Error('Declaration emit skipped');
  const result = await build({
    absWorkingDir: stage,
    entryPoints,
    outdir: path.join(pkg, 'dist'),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    jsx: 'automatic',
    metafile: true,
    plugins: [
      {
        name: 'public-dependencies-only',
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => {
            // Absolute entrypoints are handled by esbuild; bare dependencies must be declared public exports.
            if (path.isAbsolute(specifier)) return;
            checkPublicImport(specifier, manifest, manifests);
            return { path: specifier, external: true };
          });
        },
      },
    ],
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const resolved = path.resolve(stage, input);
    if (!resolved.startsWith(path.join(stage, 'src') + path.sep))
      throw new Error('Source crossed package boundary: ' + input);
  }
  await writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        private: true,
        type: 'module',
        exports: exported,
        files: ['dist', 'types', 'NOTICE.txt', 'EDITOR-EXTENSION-INTERFACE-SCOPE.md'],
        dependencies,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(path.join(pkg, 'NOTICE.txt'), notice);
  await writeFile(
    path.join(pkg, 'EDITOR-EXTENSION-INTERFACE-SCOPE.md'),
    source.read('EDITOR-EXTENSION-INTERFACE-SCOPE.md'),
  );
  const [packed] = JSON.parse(
    run(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--offline',
        '--cache',
        path.join(output, 'cache'),
        '--pack-destination',
        path.join(output, 'tarballs'),
      ],
      pkg,
    ),
  );
  evidence.packages.push({
    name: manifest.name,
    version: manifest.version,
    phase: name === 'extension-sample' ? 'extension-sample' : 'platform',
    tarball: packed.filename,
    sha256: sha256(await readFile(path.join(output, 'tarballs', packed.filename))),
    exports: exported,
    dependencies,
    declarationDependencies: closure,
    sourceFiles,
    files: await inventory(pkg),
    inputs: Object.keys(result.metafile.inputs).sort(),
  });
  console.log('BUILT / PACKED', manifest.name);
}
await writeFile(path.join(output, 'provenance.json'), JSON.stringify(evidence, null, 2) + '\n');
for (const name of kitFiles) {
  await writeFile(path.join(output, name), source.read('scripts/extension-packaging/' + name));
}
console.log('Kit:', output, 'Source:', sourceCommit);
console.log('Provenance SHA-256:', sha256(await readFile(path.join(output, 'provenance.json'))));
