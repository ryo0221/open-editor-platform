import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Serve the CSP-restricted renderer without development HTML injections.
 * @returns {import('vite').Plugin}
 */
export function officeMermaidHtml() {
  return {
    name: 'office-mermaid-raw-dev-html',
    apply: 'serve',
    configureServer(server) {
      const file = path.join(server.config.root, 'office-mermaid.html');
      // Returned hook runs after Vite's request/CORS/Host guards, before index HTML.
      return () =>
        server.middlewares.use((req, res, next) => {
          const originalPath = (req.originalUrl ?? req.url ?? '').split('?')[0];
          if (!['GET', 'HEAD'].includes(req.method) || originalPath !== '/office-mermaid.html') {
            next();
            return;
          }
          void readFile(file).then(
            (bytes) => {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('Content-Length', bytes.byteLength);
              res.end(req.method === 'HEAD' ? undefined : bytes);
            },
            () => {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.end(req.method === 'HEAD' ? undefined : 'Office renderer HTML unavailable');
            },
          );
        });
    },
  };
}
