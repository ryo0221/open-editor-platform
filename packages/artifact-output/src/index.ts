import {
  canonicalJson,
  clone,
  contentHash,
  deepFreeze,
  type Artifact,
} from '@editor-platform/artifact-core';

export interface OutputSource {
  artifactId: string;
  kind: string;
  versionId: string;
  contentHash: string;
}
export interface OutputFile {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}
/** Host attests to original implementation/dependency identities. No original bytes here. */
export interface OutputDependency {
  id: string;
  version: string;
  hash: string;
}
export interface ArtifactOutputManifest {
  schemaVersion: 1;
  source: OutputSource;
  generator: { id: string; version: string };
  dependencies: OutputDependency[];
  files: { path: string; mediaType: string; byteLength: number; hash: string }[];
  fingerprint: string;
}
export const artifactOutputLimits = Object.freeze({ files: 256, bytes: 16 * 1024 * 1024 });
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,511}$/.test(v);
const version = (v: unknown) =>
  id(v) && !['latest', 'main', 'head', '*', 'next'].includes(String(v).toLowerCase());
const safePath = (v: unknown) =>
  typeof v === 'string' &&
  v.length <= 240 &&
  v
    .split('/')
    .every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && part !== '.' && part !== '..') &&
  !v.includes('\\');
const media = (v: unknown) => typeof v === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(v);
function plain(
  raw: unknown,
  depth = 0,
  active = new Set<object>(),
  budget = { remaining: 100000 },
) {
  if (--budget.remaining < 0) throw Error('Manifest JSON exceeds value limit');
  if (depth > 32) throw Error('Manifest JSON exceeds depth limit');
  if (
    raw === null ||
    typeof raw === 'string' ||
    typeof raw === 'boolean' ||
    (typeof raw === 'number' && Number.isFinite(raw))
  )
    return;
  if (
    !raw ||
    typeof raw !== 'object' ||
    active.has(raw) ||
    ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(raw))
  )
    throw Error('Manifest must contain plain finite JSON');
  active.add(raw);
  if (Array.isArray(raw) && Reflect.ownKeys(raw).length !== raw.length + 1)
    throw Error('Manifest arrays must be dense and unnamed');
  for (const key of Reflect.ownKeys(raw)) {
    if (Array.isArray(raw) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (
      typeof key !== 'string' ||
      ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw Error('Manifest accessors/hooks are unsupported');
    plain(descriptor.value, depth + 1, active, budget);
  }
  active.delete(raw);
}
function shape(raw: unknown, fields: string[]) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(raw, key))
  )
    throw Error('Invalid manifest fields');
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function addPath(seen: Set<string>, path: string) {
  const key = path.toLowerCase();
  if (seen.has(key)) throw Error('Duplicate output path');
  for (const previous of seen)
    if (key.startsWith(previous + '/') || previous.startsWith(key + '/'))
      throw Error('Output file/directory path collision');
  seen.add(key);
}
function assertFiles(files: OutputFile[]) {
  if (!Array.isArray(files) || !files.length || files.length > artifactOutputLimits.files)
    throw Error('Invalid output file count');
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (
      !safePath(file.path) ||
      !media(file.mediaType) ||
      !(file.bytes instanceof Uint8Array) ||
      seen.has(file.path.toLowerCase())
    )
      throw Error('Invalid, duplicate or unsafe output file');
    addPath(seen, file.path);
    bytes += file.bytes.byteLength;
  }
  if (bytes > artifactOutputLimits.bytes) throw Error('Output byte budget exceeded');
}
async function bytesHash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function assertMetadata(raw: Omit<ArtifactOutputManifest, 'fingerprint'>) {
  shape(raw, ['schemaVersion', 'source', 'generator', 'dependencies', 'files']);
  shape(raw.source, ['artifactId', 'kind', 'versionId', 'contentHash']);
  shape(raw.generator, ['id', 'version']);
  if (
    raw.schemaVersion !== 1 ||
    !id(raw.source?.artifactId) ||
    !id(raw.source.kind) ||
    !id(raw.source.versionId) ||
    !hash(raw.source.contentHash) ||
    !id(raw.generator?.id) ||
    !version(raw.generator.version) ||
    !Array.isArray(raw.dependencies) ||
    raw.dependencies.length > 256
  )
    throw Error('Invalid source or generator pin');
  const seen = new Set<string>();
  for (const dep of raw.dependencies) {
    shape(dep, ['id', 'version', 'hash']);
    if (!id(dep.id) || !version(dep.version) || !hash(dep.hash) || seen.has(dep.id))
      throw Error('Invalid or duplicate Host dependency pin');
    seen.add(dep.id);
  }
  if (
    !Array.isArray(raw.files) ||
    !raw.files.length ||
    raw.files.length > artifactOutputLimits.files
  )
    throw Error('Invalid output manifest files');
  const paths = new Set<string>();
  let bytes = 0;
  for (const f of raw.files) {
    shape(f, ['path', 'mediaType', 'byteLength', 'hash']);
    if (
      !safePath(f.path) ||
      paths.has(f.path.toLowerCase()) ||
      !media(f.mediaType) ||
      !hash(f.hash) ||
      !Number.isSafeInteger(f.byteLength) ||
      f.byteLength < 0
    )
      throw Error('Invalid output file metadata');
    addPath(paths, f.path);
    bytes += f.byteLength;
  }
  if (bytes > artifactOutputLimits.bytes) throw Error('Output byte budget exceeded');
}
/** Caller supplies files for the selected saved version; this API never commits a draft. */
export async function createArtifactOutputManifest<T>(
  artifact: Artifact<T>,
  versionId: string,
  generator: ArtifactOutputManifest['generator'],
  files: OutputFile[],
  dependencies: OutputDependency[] = [],
): Promise<ArtifactOutputManifest> {
  // Own inputs before the first await; edits during hashing cannot change this handoff.
  const matches = artifact.versions.filter((v) => v.versionId === versionId);
  if (matches.length !== 1) throw Error('Select one existing immutable Artifact version');
  const selected = matches[0];
  if (selected.artifactId !== artifact.id)
    throw Error('Selected version does not belong to the source Artifact');
  const saved = clone(selected);
  const source = {
    artifactId: artifact.id,
    kind: artifact.kind,
    versionId,
    contentHash: saved.contentHash,
  };
  assertFiles(files);
  const owned = files.map((f) => ({ ...f, bytes: new Uint8Array(f.bytes) }));
  assertFiles(owned);
  plain(generator);
  plain(dependencies);
  const pins = clone(dependencies).sort((a, b) => compare(a.id, b.id));
  const generatorPin = clone(generator);
  if ((await contentHash(saved.content)) !== saved.contentHash)
    throw Error('Saved source content hash mismatch');
  const result = {
    schemaVersion: 1 as const,
    source,
    generator: generatorPin,
    dependencies: pins,
    files: await Promise.all(
      owned
        .sort((a, b) => compare(a.path, b.path))
        .map(async (f) => ({
          path: f.path,
          mediaType: f.mediaType,
          byteLength: f.bytes.byteLength,
          hash: await bytesHash(f.bytes),
        })),
    ),
  };
  assertMetadata(result);
  return deepFreeze({ ...result, fingerprint: await contentHash(result) });
}
/** Files, source identity and Host pins must all match; hashes do not authenticate a Host. */
export async function verifyArtifactOutputManifest(
  raw: unknown,
  files: OutputFile[],
  expected: Pick<ArtifactOutputManifest, 'source' | 'generator' | 'dependencies'>,
): Promise<ArtifactOutputManifest> {
  if (!raw || typeof raw !== 'object') throw Error('Invalid output manifest');
  plain(raw);
  plain(expected);
  shape(raw, ['schemaVersion', 'source', 'generator', 'dependencies', 'files', 'fingerprint']);
  const owned = clone(raw) as ArtifactOutputManifest;
  const pins = clone(expected);
  assertFiles(files);
  const copied = files.map((f) => ({ ...f, bytes: new Uint8Array(f.bytes) }));
  const { fingerprint, ...metadata } = owned;
  assertMetadata(metadata);
  if (!hash(fingerprint) || (await contentHash(metadata)) !== fingerprint)
    throw Error('Manifest fingerprint mismatch');
  if (
    canonicalJson(owned.source) !== canonicalJson(pins.source) ||
    canonicalJson(owned.generator) !== canonicalJson(pins.generator) ||
    canonicalJson(owned.dependencies) !==
      canonicalJson([...pins.dependencies].sort((a, b) => compare(a.id, b.id)))
  )
    throw Error('Output source/generator/Host dependency pin mismatch');
  if (copied.length !== owned.files.length) throw Error('Output file set mismatch');
  const byPath = new Map(copied.map((f) => [f.path, f]));
  for (const f of owned.files) {
    const found = byPath.get(f.path);
    if (
      !found ||
      found.mediaType !== f.mediaType ||
      found.bytes.byteLength !== f.byteLength ||
      (await bytesHash(found.bytes)) !== f.hash
    )
      throw Error('Output file mismatch: ' + f.path);
  }
  return deepFreeze(owned);
}
