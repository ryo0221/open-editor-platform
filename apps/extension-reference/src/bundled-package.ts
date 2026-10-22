/** Private offline fixture admission. No code loading, registry or second catalog. */
import { canonicalJson } from '@editor-platform/artifact-core';
import { parseManifest } from '@editor-platform/extension-runtime';
import type { ExtensionManifest } from '@editor-platform/extension-contract';
export type BundleManifest = Omit<ExtensionManifest, 'packageHash'>;
export interface BundledPackage {
  manifest: BundleManifest;
  entry: string;
  files: { path: string; bytes: Uint8Array }[];
}
async function sha(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
function path(value: string) {
  return (
    typeof value === 'string' &&
    value.length <= 200 &&
    /^[a-zA-Z0-9_-]+(?:[./-][a-zA-Z0-9_-]+)*$/.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}
/** Build-side descriptor calculation; its result is NOT a trust decision. */
export async function describeBundledPackage(input: BundledPackage) {
  const metadata = structuredClone({ manifest: input.manifest, entry: input.entry });
  const parsed = parseManifest({ ...metadata.manifest, packageHash: `sha256:${'0'.repeat(64)}` });
  const { packageHash: _ignored, ...manifest } = parsed;
  if (canonicalJson(manifest) !== canonicalJson(metadata.manifest))
    throw Error('Bundle manifest fields');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 128)
    throw Error('Bundle file count');
  // Own every byte before the first await. Caller mutation cannot change admitted data.
  let total = 0;
  const files = input.files
    .map((file) => {
      if (!path(file.path) || !(file.bytes instanceof Uint8Array)) throw Error('Bundle file');
      total += file.bytes.byteLength;
      if (total > 16 * 1024 * 1024) throw Error('Bundle byte budget');
      return { path: file.path, bytes: Uint8Array.from(file.bytes) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    new Set(files.map((f) => f.path)).size !== files.length ||
    !files.some((f) => f.path === metadata.entry)
  )
    throw Error('Bundle entry or duplicate file');
  const records = [];
  for (const file of files)
    records.push({ path: file.path, byteLength: file.bytes.length, sha256: await sha(file.bytes) });
  const descriptor = {
    format: 'extension-offline-fixture-1',
    manifest,
    entry: metadata.entry,
    files: records,
  };
  const hash = `sha256:${await sha(new TextEncoder().encode(canonicalJson(descriptor)))}`;
  return { descriptor, hash, files };
}
/** lookup is Host-owned, never read from the package. Missing/revoked pins refuse. */
export async function verifyBundledPackage(
  input: BundledPackage,
  lookup: (id: string, version: string) => string | undefined,
) {
  const prepared = await describeBundledPackage(input);
  const manifest = parseManifest({ ...prepared.descriptor.manifest, packageHash: prepared.hash });
  const assertTrusted = () => {
    if (lookup(manifest.id, manifest.version) !== prepared.hash)
      throw Error('Untrusted bundle pin');
  };
  assertTrusted();
  return Object.freeze({
    manifest,
    entry: prepared.descriptor.entry,
    assertTrusted,
    readFile(name: string) {
      assertTrusted();
      const file = prepared.files.find((f) => f.path === name);
      if (!file) throw Error('Missing bundle file');
      return Uint8Array.from(file.bytes);
    },
  });
}
