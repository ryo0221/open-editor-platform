import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Development CAD kernel (npm opencascade.js, see experiments/cad-kernel-d0). It stays outside
// Git and outside the bundle: CAD_OCCT_DIST names its dist directory, the dev/preview server
// serves the two files, and `virtual:cad-kernel-build` tells the Host whether and what to load.
const files = {
  '/cad-kernel/kernel.js': 'opencascade.full.js',
  '/cad-kernel/kernel.wasm': 'opencascade.full.wasm',
};
const id = 'virtual:cad-kernel-build';
export function cadDevelopmentKernel(dist = process.env.CAD_OCCT_DIST) {
  const available = !!dist && Object.values(files).every((f) => existsSync(path.join(dist, f)));
  const build = available
    ? {
        buildHash: `sha256:${createHash('sha256')
          .update(readFileSync(path.join(dist, files['/cad-kernel/kernel.wasm'])))
          .digest('hex')}`,
        moduleUrl: '/cad-kernel/kernel.js',
        wasmUrl: '/cad-kernel/kernel.wasm',
      }
    : null;
  const serve = (req, res, next) => {
    const file = available && files[(req.url ?? '').split('?')[0]];
    if (!file) return next();
    res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    createReadStream(path.join(dist, file)).pipe(res);
  };
  return {
    name: 'cad-development-kernel',
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load: (resolved) =>
      resolved === '\0' + id ? `export default ${JSON.stringify(build)};` : undefined,
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
  };
}
