import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { cadKernelBuild, cadKernelPrevious } from '../cad-kernel/build.mjs';

// Development CAD kernel (the custom OpenCascade.js build, see scripts/cad-kernel). It stays
// outside Git and outside the bundle: CAD_OCCT_DIST names its output directory, the dev/preview
// server serves the two files, and `virtual:cad-kernel-build` tells the Host whether and what to load.
// CAD_OCCT_RETAINED (comma-separated directories) serves earlier builds listed in build.mjs.
// The notice written by scripts/cad-kernel/bundle.sh is served next to the current build when present.
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
