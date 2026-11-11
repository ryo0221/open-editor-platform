/**
 * Public verified-package admission and loading for trusted, Host-pinned Extension packages.
 *
 * Trust root: the consuming Host's pin lookup (package id + version -> packageHash). Nothing read
 * from a package establishes trust. This is integrity checking for explicitly trusted local
 * packages, not a sandbox for arbitrary third-party code.
 *
 * `packageHash` is `sha256:` + SHA-256 of the canonical JSON descriptor
 * `{ format, manifest (without packageHash), entry, files: [{ path, byteLength, sha256 }] }`
 * over every admitted file (executable code, notices and data). It is neither the raw digest of a
 * distribution archive (tarball) nor an Artifact `contentHash`.
 */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { ExtensionDefinition, ExtensionManifest } from '@editor-platform/extension-contract';
import { parseManifest, type ExtensionRegistry, type Registration } from './index';

/** Descriptor format tag included in every packageHash. Changing it changes every pin. */
export const PACKAGE_DESCRIPTOR_FORMAT = 'extension-offline-fixture-1' as const;
export const PACKAGE_LIMITS = Object.freeze({ files: 128, bytes: 16 * 1024 * 1024, path: 200 });

export type PackageManifest = Omit<ExtensionManifest, 'packageHash'>;
export interface ExtensionPackage {
  manifest: PackageManifest;
  /** Closed ESM module exporting `definition(packageHash)`. */
  entry: string;
  files: { path: string; bytes: Uint8Array }[];
}
/** Host-owned allowlist. Return undefined for an unknown, revoked or withdrawn package. */
export type PackagePinLookup = (id: string, version: string) => string | undefined;
export interface PackageDescriptor {
  format: typeof PACKAGE_DESCRIPTOR_FORMAT;
  manifest: PackageManifest;
  entry: string;
  files: { path: string; byteLength: number; sha256: string }[];
}
export interface VerifiedPackage {
  /** Manifest with the computed packageHash. */
  readonly manifest: ExtensionManifest;
  readonly entry: string;
  /** Every admitted file path, sorted; together with readFile it reproduces the verified package. */
  readonly paths: readonly string[];
  /** Throws unless the Host pin still equals the verified hash. */
  assertTrusted(): void;
  /** Copy of verified owned bytes; rechecks the pin on every read. */
  readFile(path: string): Uint8Array;
}
export interface LoadedExtension<T> {
  readonly manifest: ExtensionManifest;
  readonly definition: ExtensionDefinition<T>;
  assertTrusted(): void;
}
/** Results of loadVerifiedExtension; install accepts nothing else. */
const issued = new WeakSet<object>();
/** Imports the given verified module bytes. Must not fetch from the package's original source. */
export type ModuleImporter = (bytes: Uint8Array) => Promise<unknown>;

async function sha(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
function localPath(value: string) {
  return (
    typeof value === 'string' &&
    value.length <= PACKAGE_LIMITS.path &&
    /^[a-zA-Z0-9_-]+(?:[./-][a-zA-Z0-9_-]+)*$/.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

/** Build-side descriptor calculation. Its result is NOT a trust decision. */
export async function describeExtensionPackage(input: ExtensionPackage) {
  const metadata = structuredClone({ manifest: input.manifest, entry: input.entry });
  const parsed = parseManifest({ ...metadata.manifest, packageHash: `sha256:${'0'.repeat(64)}` });
  const { packageHash: _ignored, ...manifest } = parsed;
  if (canonicalJson(manifest) !== canonicalJson(metadata.manifest))
    throw Error('Package manifest fields');
  if (
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > PACKAGE_LIMITS.files
  )
    throw Error('Package file count');
  // Own every byte before the first await. Caller mutation cannot change admitted data.
  let total = 0;
  const files = input.files
    .map((file) => {
      if (!localPath(file.path) || !(file.bytes instanceof Uint8Array)) throw Error('Package file');
      total += file.bytes.byteLength;
      if (total > PACKAGE_LIMITS.bytes) throw Error('Package byte budget');
      return { path: file.path, bytes: Uint8Array.from(file.bytes) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    new Set(files.map((f) => f.path)).size !== files.length ||
    !files.some((f) => f.path === metadata.entry)
  )
    throw Error('Package entry or duplicate file');
  const records = [];
  for (const file of files)
    records.push({ path: file.path, byteLength: file.bytes.length, sha256: await sha(file.bytes) });
  const descriptor: PackageDescriptor = {
    format: PACKAGE_DESCRIPTOR_FORMAT,
    manifest,
    entry: metadata.entry,
    files: records,
  };
  const hash = `sha256:${await sha(new TextEncoder().encode(canonicalJson(descriptor)))}`;
  return { descriptor, hash, files };
}

/** Verifies complete owned bytes against the Host pin. Missing/revoked/different pins refuse. */
export async function verifyExtensionPackage(
  input: ExtensionPackage,
  lookup: PackagePinLookup,
): Promise<VerifiedPackage> {
  const prepared = await describeExtensionPackage(input);
  const manifest = parseManifest({ ...prepared.descriptor.manifest, packageHash: prepared.hash });
  const assertTrusted = () => {
    if (lookup(manifest.id, manifest.version) !== prepared.hash)
      throw Error('Untrusted package pin');
  };
  assertTrusted();
  return Object.freeze({
    manifest,
    entry: prepared.descriptor.entry,
    paths: Object.freeze(prepared.files.map((f) => f.path)),
    assertTrusted,
    readFile(name: string) {
      assertTrusted();
      const file = prepared.files.find((f) => f.path === name);
      if (!file) throw Error('Missing package file');
      return Uint8Array.from(file.bytes);
    },
  });
}

/** Browser default: a Blob module URL over the exact verified bytes, revoked after import. */
export const importBlobModule: ModuleImporter = async (bytes) => {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * Imports only the verified entry bytes and checks the returned definition against the verified
 * manifest. Works for any package id / artifactKind; the Host pin decides what may load.
 * The entry must be a closed module: blob URLs cannot resolve relative imports, and the Host must
 * not provide import maps that resolve bare specifiers to unverified code.
 */
export async function loadVerifiedExtension<T>(
  verified: VerifiedPackage,
  options: { importModule?: ModuleImporter } = {},
): Promise<LoadedExtension<T>> {
  const bytes = verified.readFile(verified.entry);
  const module = await (options.importModule ?? importBlobModule)(bytes);
  verified.assertTrusted();
  const factory = (module as { definition?: unknown } | null)?.definition;
  if (typeof factory !== 'function') throw Error('Package entry must export definition()');
  const returned = factory(verified.manifest.packageHash) as ExtensionDefinition<T>;
  if (
    !returned ||
    typeof returned !== 'object' ||
    canonicalJson(returned.manifest) !== canonicalJson(verified.manifest)
  )
    throw Error('Definition differs from verified manifest');
  // Own the checked definition: read each member once into a frozen object whose manifest is the
  // frozen verified manifest. Later changes through the factory's or caller's references cannot
  // alter what installVerifiedExtension registers.
  const validate = returned.validate,
    mount = returned.mount,
    ops = returned.operations;
  if (typeof validate !== 'function') throw Error('Missing domain validator');
  if (mount !== undefined && typeof mount !== 'function') throw Error('Invalid surface adapter');
  let operations: ExtensionDefinition<T>['operations'];
  if (ops !== undefined) {
    const checkInput = ops?.checkInput,
      command = ops?.command;
    if (typeof checkInput !== 'function' || typeof command !== 'function')
      throw Error('Invalid operations adapter');
    operations = Object.freeze({
      checkInput: (...args: Parameters<typeof checkInput>) => checkInput.apply(ops, args),
      command: (...args: Parameters<typeof command>) => command.apply(ops, args),
    });
  }
  const definition: ExtensionDefinition<T> = Object.freeze({
    manifest: verified.manifest,
    validate,
    ...(mount ? { mount } : {}),
    ...(operations ? { operations } : {}),
  });
  const loaded: LoadedExtension<T> = Object.freeze({
    manifest: verified.manifest,
    definition,
    assertTrusted: verified.assertTrusted,
  });
  issued.add(loaded);
  return loaded;
}

/** Rechecks the Host pin and installs with the verified hash; never a manifest self-assertion. */
export function installVerifiedExtension<T>(
  registry: ExtensionRegistry,
  loaded: LoadedExtension<T>,
  options: { replace?: boolean } = {},
): Registration<T> {
  if (
    !issued.has(loaded) ||
    loaded.definition.manifest !== loaded.manifest ||
    canonicalJson(loaded.definition.manifest) !== canonicalJson(loaded.manifest)
  )
    throw Error('Not a definition returned by loadVerifiedExtension');
  loaded.assertTrusted();
  return registry.install(loaded.definition, {
    trust: 'trusted',
    verifiedPackageHash: loaded.manifest.packageHash,
    replace: options.replace,
    assertTrusted: loaded.assertTrusted,
  });
}
