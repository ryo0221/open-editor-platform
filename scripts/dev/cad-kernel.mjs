import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { cadKernelBuild, cadKernelPrevious } from '../cad-kernel/build.mjs';

// Development CAD kernel (the custom OpenCascade.js build, see scripts/cad-kernel). It stays
// outside Git: CAD_OCCT_DIST names its output directory, the dev/preview
// server serves the files; a static build also emits the verified kernel, NOTICE and source. `virtual:cad-kernel-build` tells the Host whether and what to load.
// CAD_OCCT_RETAINED (comma-separated directories) serves earlier builds listed in build.mjs.
// The notice written by scripts/cad-kernel/bundle.sh is served next to the current build when present.
// Independent of the supplied checksum manifest: bundle.sh must provide all
// corresponding source archives, toolchain provenance and reproducible inputs.
const requiredSourceFiles = [
  'NOTICE.txt',
  'source/occt-bb368e2.tar.gz',
  'source/opencascade.js-src.tar.gz',
  'source/emscripten-version.txt',
  'source/occt-commit.txt',
  'source/image.txt',
  'source/editor-platform-cad-kernel/README.md',
  'source/editor-platform-cad-kernel/build.mjs',
  'source/editor-platform-cad-kernel/build.sh',
  'source/editor-platform-cad-kernel/bundle.sh',
  'source/editor-platform-cad-kernel/opencascade.d0-leakcheck.yml',
  'source/editor-platform-cad-kernel/patch-destructors.py',
];
const id = 'virtual:cad-kernel-build';
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function cadDevelopmentKernel(
  dist = process.env.CAD_OCCT_DIST,
  retainedDirs = process.env.CAD_OCCT_RETAINED,
  { current = cadKernelBuild, previous = cadKernelPrevious } = {},
) {
  /** URL path → file on disk, for every served build. */
  const routes = new Map();
  const serveBuild = (dir, spec, base) => {
    const sha = sha256(path.join(dir, spec.wasm));
    if (sha !== spec.wasmSha256)
      throw new Error(`${dir}: kernel Wasm ${sha} differs from scripts/cad-kernel/build.mjs`);
    if (spec.jsSha256 && sha256(path.join(dir, spec.js)) !== spec.jsSha256)
      throw new Error(`${dir}: kernel loader differs from scripts/cad-kernel/build.mjs`);
    routes.set(`${base}/kernel.js`, path.join(dir, spec.js));
    routes.set(`${base}/kernel.wasm`, path.join(dir, spec.wasm));
    return {
      id: spec.id,
      buildHash: `sha256:${sha}`,
      moduleUrl: `${base}/kernel.js`,
      wasmUrl: `${base}/kernel.wasm`,
    };
  };
  const available =
    !!dist && [current.js, current.wasm].every((f) => existsSync(path.join(dist, f)));
  const build = available ? serveBuild(dist, current, '/cad-kernel') : null;
  if (available && existsSync(path.join(dist, 'NOTICE.txt')))
    routes.set('/cad-kernel/NOTICE.txt', path.join(dist, 'NOTICE.txt'));
  const retained = (retainedDirs ? retainedDirs.split(',') : []).filter(Boolean).map((dir) => {
    const sha = sha256(path.join(dir, previousWasm(dir, previous)));
    const spec = previous.find((p) => p.wasmSha256 === sha);
    if (!spec) throw new Error(`CAD_OCCT_RETAINED: ${dir} is not an earlier build in build.mjs`);
    return serveBuild(dir, spec, `/cad-kernel/${sha.slice(0, 12)}`);
  });
  const kernels = {
    retained,
    revoked: previous.filter((p) => p.revoked).map((p) => `sha256:${p.wasmSha256}`),
    substitutes: build
      ? previous
          .filter((p) => p.substitute && !p.revoked)
          .map((p) => ({
            from: `sha256:${p.wasmSha256}`,
            to: build.buildHash,
            semanticsVersion: 2,
          }))
      : [],
  };
  const serve = (req, res, next) => {
    const file = routes.get((req.url ?? '').split('?')[0]);
    if (!file) return next();
    const type = { '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
    res.setHeader('Content-Type', type[path.extname(file)] ?? 'text/javascript');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'cad-development-kernel',
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load: (resolved) =>
      resolved === '\0' + id
        ? `export default ${JSON.stringify(build)};\nexport const kernels = ${JSON.stringify(kernels)};`
        : undefined,
    generateBundle() {
      // Static distribution must be self-contained, including corresponding sources.
      if (!build && !retained.length) return;
      const dirs = [
        ...(build ? [[dist, '/cad-kernel']] : []),
        ...retained.map((b, i) => [
          retainedDirs.split(',').filter(Boolean)[i],
          `/cad-kernel/${b.buildHash.slice(7, 19)}`,
        ]),
      ];
      const assets = new Map(routes);
      for (const [dir, base] of dirs) {
        const sumsFile = path.join(dir, 'source/SHA256SUMS');
        if (!existsSync(path.join(dir, 'NOTICE.txt')) || !existsSync(sumsFile))
          throw Error(
            `${dir}: static CAD distribution requires NOTICE.txt and source/SHA256SUMS (bundle.sh)`,
          );
        const listed = new Set();
        for (const line of readFileSync(sumsFile, 'utf8').trim().split('\n')) {
          const m = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
          if (
            !m ||
            !(m[2] === 'NOTICE.txt' || m[2].startsWith('source/')) ||
            m[2].split('/').includes('..')
          )
            throw Error(`${dir}: invalid source checksum entry`);
          const file = path.join(dir, m[2]);
          // Refuse symlinks at every component, including source/ itself.
          let current = dir;
          for (const part of m[2].split('/')) {
            current = path.join(current, part);
            if (lstatSync(current).isSymbolicLink()) throw Error(`${current}: source symlink`);
          }
          if (!lstatSync(file).isFile() || sha256(file) !== m[1])
            throw Error(`${file}: source checksum mismatch`);
          listed.add(m[2]);
          assets.set(`${base}/${m[2]}`, file);
        }
        const missing = requiredSourceFiles.filter((file) => !listed.has(file));
        if (missing.length)
          throw Error(`${dir}: incomplete corresponding source manifest: ${missing.join(', ')}`);
        if (!lstatSync(sumsFile).isFile() || lstatSync(sumsFile).isSymbolicLink())
          throw Error('source checksum symlink');
        assets.set(`${base}/source/SHA256SUMS`, sumsFile);
      }
      for (const [url, file] of assets)
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: readFileSync(file) });
    },
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
  };
}
/** The Wasm file of a retained directory: the one named by an earlier build that exists there. */
function previousWasm(dir, previous) {
  const name = previous.map((p) => p.wasm).find((f) => existsSync(path.join(dir, f)));
  if (!name) throw new Error(`CAD_OCCT_RETAINED: no earlier kernel Wasm in ${dir}`);
  return name;
}
