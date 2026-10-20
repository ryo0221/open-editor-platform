import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const virtual = 'virtual:animation-runtime-pin';
/** Pin the bundled trusted component's complete executable dependency closure.
 * Optional source overrides are for deterministic mutation regression tests only.
 */
export async function buildAnimationRuntimePin(overrides = {}) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['apps/animation-reference/src/registered-player.tsx'],
    outdir: 'work/issue74-2d/runtime-pin',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'reviewed-source-overrides',
        setup(builder) {
          if (!Object.keys(overrides).length) return;
          builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path: filename }) => {
            const relative = path.relative(root, filename);
            if (!Object.hasOwn(overrides, relative)) return;
            return {
              contents: (await readFile(filename, 'utf8')) + '\n' + overrides[relative],
              loader: filename.endsWith('.tsx') ? 'tsx' : filename.endsWith('.ts') ? 'ts' : 'js',
              resolveDir: path.dirname(filename),
            };
          });
        },
      },
    ],
  });
  const hash = createHash('sha256');
  for (const output of result.outputFiles.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(path.basename(output.path)).update('\0').update(output.contents).update('\0');
  }
  return { hash: hash.digest('hex'), inputs: Object.keys(result.metafile.inputs).sort() };
}
export function animationRuntimePin() {
  let pin;
  let inputs = new Set();
  return {
    name: 'animation-runtime-pin',
    resolveId(id) {
      if (id === virtual) return '\0' + virtual;
    },
    async load(id) {
      if (id !== '\0' + virtual) return;
      pin ??= buildAnimationRuntimePin();
      const result = await pin;
      inputs = new Set(result.inputs.map((name) => path.resolve(root, name)));
      for (const filename of inputs) this.addWatchFile(filename);
      return 'export default ' + JSON.stringify(result);
    },
    handleHotUpdate(context) {
      if (!inputs.has(context.file)) return;
      pin = undefined;
      const module = context.server.moduleGraph.getModuleById('\0' + virtual);
      if (module) context.server.moduleGraph.invalidateModule(module);
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
