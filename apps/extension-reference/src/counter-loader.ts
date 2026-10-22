/** Loads only the closed, trusted Host-built Counter graph, from the exact verified bytes. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { ExtensionDefinition } from '@editor-platform/extension-contract';
import type { Counter } from '@editor-platform/extension-sample';
import { verifyBundledPackage, type BundledPackage } from './bundled-package';
export async function loadBundledCounter(
  bundle: BundledPackage,
  lookup: (id: string, version: string) => string | undefined,
) {
  const verified = await verifyBundledPackage(bundle, lookup);
  if (verified.manifest.id !== 'example.counter') throw Error('Expected bundled Counter');
  const url = URL.createObjectURL(
    new Blob([verified.readFile(verified.entry)], { type: 'text/javascript' }),
  );
  try {
    verified.assertTrusted();
    const module = await import(/* @vite-ignore */ url);
    verified.assertTrusted();
    const definition: ExtensionDefinition<Counter> = module.definition(
      verified.manifest.packageHash,
    );
    if (canonicalJson(definition.manifest) !== canonicalJson(verified.manifest))
      throw Error('Counter definition differs from verified manifest');
    return { definition, assertTrusted: verified.assertTrusted };
  } finally {
    URL.revokeObjectURL(url);
  }
}
