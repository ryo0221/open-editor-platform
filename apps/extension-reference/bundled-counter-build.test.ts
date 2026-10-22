import { expect, it } from 'vitest';
import { buildCounterPackages } from './bundled-counter-build';
import { verifyBundledPackage } from './src/bundled-package';

it('pins both real closed Counter bundles reproducibly, including their distinct manifests', async () => {
  const packages = await buildCounterPackages();
  expect(await buildCounterPackages()).toEqual(packages);
  expect(packages[0].hash).not.toBe(packages[1].hash);
  for (const bundle of packages) {
    const input = {
      ...bundle,
      files: bundle.files.map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.text) })),
    };
    const verified = await verifyBundledPackage(input, (id, version) =>
      id === 'example.counter' && version === bundle.manifest.version ? bundle.hash : undefined,
    );
    const module = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(verified.readFile(verified.entry)).toString('base64')}`
    );
    expect(module.definition(bundle.hash).manifest).toEqual(verified.manifest);
    input.files[0].bytes[0] ^= 1;
    await expect(verifyBundledPackage(input, () => bundle.hash)).rejects.toThrow('Untrusted');
  }
});
