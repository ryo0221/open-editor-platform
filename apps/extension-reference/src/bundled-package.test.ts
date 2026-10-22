import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { counterExtension } from '@editor-platform/extension-sample';
import { ExtensionRegistry } from '@editor-platform/extension-runtime';
import {
  describeBundledPackage,
  verifyBundledPackage,
  type BundledPackage,
} from './bundled-package';
function metadata() {
  const { packageHash: _hash, ...manifest } = counterExtension(`sha256:${'0'.repeat(64)}`).manifest;
  return manifest;
}
function fixture(): BundledPackage {
  return {
    manifest: metadata(),
    entry: 'entry.js',
    files: [
      { path: 'entry.js', bytes: new TextEncoder().encode('export const value = 1;') },
      { path: 'LICENSE.txt', bytes: new TextEncoder().encode('Fixture, no new license grant.') },
    ],
  };
}
it('admits owned complete bytes and checks revocation on access', async () => {
  const source = fixture(),
    expected = (await describeBundledPackage(source)).hash;
  let allowed: string | undefined = expected;
  const result = await verifyBundledPackage(source, () => allowed);
  source.files[0].bytes.fill(0);
  const bytes = result.readFile('entry.js');
  bytes.fill(0);
  expect(new TextDecoder().decode(result.readFile('entry.js'))).toBe('export const value = 1;');
  allowed = undefined;
  expect(() => result.readFile('entry.js')).toThrow('Untrusted');
});
it.each(['chunk', 'notice', 'manifest', 'entry', 'extra', 'missing'] as const)(
  'rejects changed %s under the fixed original pin',
  async (kind) => {
    const source = fixture(),
      expected = (await describeBundledPackage(source)).hash;
    if (kind === 'chunk') source.files[0].bytes[0] ^= 1;
    if (kind === 'notice') source.files[1].bytes[0] ^= 1;
    if (kind === 'manifest') source.manifest.version = '0.0.2';
    if (kind === 'entry') source.entry = 'LICENSE.txt';
    if (kind === 'extra') source.files.push({ path: 'extra.js', bytes: new Uint8Array([1]) });
    if (kind === 'missing') source.files.pop();
    await expect(verifyBundledPackage(source, () => expected)).rejects.toThrow();
  },
);
it.each(['../evil.js', '/root.js', 'https://example.com/a.js', 'a\\b.js', 'a/../b.js'])(
  'refuses nonlocal path %s',
  async (name) => {
    const source = fixture();
    source.files[0].path = name;
    await expect(verifyBundledPackage(source, () => 'unused')).rejects.toThrow();
  },
);
it('rejects duplicate files and a revoked pin while digesting', async () => {
  const source = fixture();
  source.files.push(source.files[0]);
  await expect(describeBundledPackage(source)).rejects.toThrow('duplicate');
  await expect(verifyBundledPackage(fixture(), () => undefined)).rejects.toThrow('Untrusted');
});
it('verifies a real bundled Counter before import and registry installation', async () => {
  const built = await build({
    entryPoints: ['packages/extension-sample/src/index.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    legalComments: 'inline',
  });
  expect(Object.values(built.metafile!.outputs).flatMap((o) => o.imports)).toEqual([]);
  const bundle: BundledPackage = {
    manifest: metadata(),
    entry: 'counter.js',
    files: [{ path: 'counter.js', bytes: built.outputFiles![0].contents }],
  };
  // Trusted build output establishes this fixture's fixed pin before any input mutation/import.
  const pin = (await describeBundledPackage(bundle)).hash;
  const verified = await verifyBundledPackage(bundle, (id, version) =>
    id === 'example.counter' && version === '0.0.1' ? pin : undefined,
  );
  const url = `data:text/javascript;base64,${Buffer.from(verified.readFile(verified.entry)).toString('base64')}`;
  verified.assertTrusted();
  const module = await import(/* @vite-ignore */ url);
  const definition = module.counterExtension(verified.manifest.packageHash);
  expect(definition.manifest).toEqual(verified.manifest);
  const registration = new ExtensionRegistry().install(definition, {
    trust: 'trusted',
    verifiedPackageHash: pin,
  });
  expect(registration.manifest.id).toBe('example.counter');
  registration.uninstall();
});

it('owns caller data before asynchronous hashes and rejects unknown manifest fields', async () => {
  const source = fixture(),
    pin = (await describeBundledPackage(source)).hash;
  const pending = verifyBundledPackage(source, () => pin);
  source.manifest.version = '9.9.9';
  source.files[0].bytes.fill(0);
  expect((await pending).manifest.version).toBe('0.0.1');
  const invalid = fixture();
  Object.assign(invalid.manifest, { additionalCode: 'ignored.js' });
  await expect(describeBundledPackage(invalid)).rejects.toThrow('fields');
});
