import assert from 'node:assert/strict';
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const revision = '44b7c4dab9bea45e3c59ccf91925a23abfb0486d';
const packages = [
  'artifact-core',
  'editor-core',
  'extension-contract',
  'extension-runtime',
  'extension-sample',
];
const directory = await mkdtemp(join(tmpdir(), 'live-legacy-runtime-'));
try {
  const archive = execFileSync(
    'git',
    ['archive', revision, ...packages.map((name) => `packages/${name}/src`)],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  const outfile = join(directory, 'runtime.mjs');
  await build({
    stdin: {
      contents: `
        export { ExtensionRegistry } from '@editor-platform/extension-runtime';
        export { counterExtension } from '@editor-platform/extension-sample';
      `,
      resolveDir: directory,
    },
    alias: Object.fromEntries(
      packages.map((name) => [
        `@editor-platform/${name}`,
        join(directory, 'packages', name, 'src', 'index.ts'),
      ]),
    ),
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
  });
  const { ExtensionRegistry, counterExtension } = await import(pathToFileURL(outfile).href);
  const hash = `sha256:${'3'.repeat(64)}`;
  const admission = { trust: 'trusted', verifiedPackageHash: hash };
  const extension = counterExtension(hash);
  const registry = new ExtensionRegistry();
  assert.throws(
    () =>
      registry.install(
        {
          ...extension,
          manifest: {
            ...extension.manifest,
            addons: { ...extension.manifest.addons, references: { version: 'references@0-draft' } },
          },
        },
        admission,
      ),
    /Unsupported add-ons/,
  );
  assert.ok(registry.install(extension, admission));
  console.log(
    'Legacy registration rejects the references add-on and accepts the original manifest.',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
