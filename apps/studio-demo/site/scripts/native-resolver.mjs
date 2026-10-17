import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const nativeResolver = {
  name: 'editor-platform-source',
  setup(build) {
    build.onResolve({ filter: /^@editor-platform\// }, (args) => {
      const parts = args.path.split('/');
      const folder = resolve(
        'vendor/editor-platform',
        parts[1] === 'reference-artifact-host' ? 'apps/artifact-host' : 'packages/' + parts[1],
      );
      const pkg = JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8'));
      const key = parts.length === 2 ? '.' : './' + parts.slice(2).join('/');
      const entry =
        typeof pkg.exports === 'string' ? (key === '.' ? pkg.exports : null) : pkg.exports[key];
      if (!entry) throw new Error('No public Editor Platform entry point: ' + args.path);
      return { path: resolve(folder, entry) };
    });
    build.onResolve({ filter: /\?url$/ }, (args) => ({
      path: require.resolve(args.path.replace(/\?url$/, '')),
      namespace: 'asset-url',
    }));
    build.onLoad({ filter: /.*/, namespace: 'asset-url' }, (args) => ({
      contents: readFileSync(args.path),
      loader: 'file',
    }));
  },
};
