import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { femMesherBuild } from '../fem-mesher/build.mjs';

// Development fem-mesher (Netgen's volume mesher as Wasm, see scripts/fem-mesher). It stays
// outside Git: FEM_MESHER_DIST names its output directory and the dev server serves it at
// /fem-mesher/. `virtual:fem-mesher-build` tells the Host whether and what to load. A static
// build carries no mesher until the build is released (scripts/fem-mesher/README.md), so there
// the module is null and the Host says why a study cannot run.
const id = 'virtual:fem-mesher-build';
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function femDevelopmentMesher(dist = process.env.FEM_MESHER_DIST, spec = femMesherBuild) {
  const available = !!dist && [spec.js, spec.wasm].every((f) => existsSync(path.join(dist, f)));
  let serving = false;
  const routes = new Map();
  let build = null;
  if (available) {
    const sha = sha256(path.join(dist, spec.wasm));
    if (sha !== spec.wasmSha256)
      throw new Error(`${dist}: fem-mesher Wasm ${sha} differs from scripts/fem-mesher/build.mjs`);
    if (sha256(path.join(dist, spec.js)) !== spec.jsSha256)
      throw new Error(`${dist}: fem-mesher loader differs from scripts/fem-mesher/build.mjs`);
    routes.set('/fem-mesher/fem-mesher.mjs', path.join(dist, spec.js));
    routes.set('/fem-mesher/fem-mesher.wasm', path.join(dist, spec.wasm));
    if (existsSync(path.join(dist, 'NOTICE.txt')))
      routes.set('/fem-mesher/NOTICE.txt', path.join(dist, 'NOTICE.txt'));
    build = {
      buildHash: `sha256:${sha}`,
      moduleUrl: '/fem-mesher/fem-mesher.mjs',
      wasmUrl: '/fem-mesher/fem-mesher.wasm',
    };
  }
  const serve = (req, res, next) => {
    const file = routes.get((req.url ?? '').split('?')[0]);
    if (!file) return next();
    const type = { '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
    res.setHeader('Content-Type', type[path.extname(file)] ?? 'text/javascript');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'fem-development-mesher',
    configResolved(config) {
      serving = config.command === 'serve';
    },
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load: (resolved) =>
      resolved === '\0' + id
        ? `export default ${JSON.stringify(serving ? build : null)};`
        : undefined,
    configureServer(server) {
      server.middlewares.use(serve);
    },
  };
}
