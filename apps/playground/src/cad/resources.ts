/**
 * The Playground's CAD asset closure (docs/cad/integration.md, D2): immutable STEP, BRep and
 * texture image (#662) bytes kept in the stored record beside the Artifact envelope, never inside the content.
 * A building (`bim`) keeps its materials' texture images (#662) the same way, in the same field,
 * and so does a character (C1d) its mesh and texture assets.
 */
import { serializeArtifact } from '@editor-platform/artifact-core';
import {
  cadAssetMediaTypes,
  type CadAssetKind,
  type CadAssetRef,
  type CadDocument,
} from '@editor-platform/cad-core';
import type { CadAssetStore } from '@editor-platform/cad';
import { characterAssetMediaTypes } from '@editor-platform/character-core';
import type { StoredArtifact } from '../model';
import { cadPartClosure, validateCadParts } from './parts';
import { portableCharacterRecord } from '../character/parts';

/** One kept asset. Shared by every content (draft or version) that names its hash. */
export interface CadResource {
  /** A CAD asset kind; a character's records hold character asset kinds here (C1d). */
  kind: CadAssetKind;
  sha256: string;
  byteLength: number;
  mediaType: string;
  encoding: 'base64';
  bytes: string;
}
/**
 * The native file must stay importable: the same limit as the Playground's native import of a
 * CAD, building, character or construction-schedule file (a schedule keeps its building versions). CR7f raised it from 16 MB to 256 MB so that a whole car read
 * from a STEP file of up to 64 MiB (its source file and its parts' BReps) can be kept. Anything
 * that would cross it is refused before it is stored.
 */
export const cadNativeLimit = {
  /** Unit tests lower it to keep their records small; nothing else changes it. */
  bytes: 256_000_000,
};
/** The kinds whose native files may be that large; the others keep the Host's 64 MiB. */
export const cadNativeKinds: ReadonlySet<string> = new Set([
  'cad',
  'bim',
  'character',
  'construction',
]);
/** The Host's native JSON limit for a record of this kind (undefined: the Host's own). */
export const hostNativeLimitOf = (kind: string) =>
  cadNativeKinds.has(kind) ? cadNativeLimit.bytes : undefined;
/** The limit as messages name it. */
export const cadNativeLimitText = () => `${cadNativeLimit.bytes / 1e6} MB`;
/** Room kept for the edit that names the staged assets (refs, feature, placement, body). */
export const cadInsertReserveBytes = 8 * 1024;

const key = (kind: string, sha256: string) => `${kind} ${sha256}`;
/**
 * The draft, every version and every retained part version (R2b): all name assets. A building's
 * draft and versions name only their own images: the CAD versions it places are drawn without
 * their textures, so their assets are not carried.
 */
const contents = (record: StoredArtifact): { assets?: readonly CadAssetRef[] }[] => [
  ...([record.draft.content, ...record.versions.map((v) => v.content)] as CadDocument[]),
  ...(record.kind === 'cad' ? cadPartClosure(record).reached.values() : []),
];
/** The kinds of record that keep asset bytes beside their content. */
const keepsAssets = (record: StoredArtifact) =>
  record.kind === 'cad' || record.kind === 'bim' || record.kind === 'character';
/** The media type each asset kind must carry, by the record's domain. */
const mediaTypesOf = (record: StoredArtifact): Readonly<Record<string, string>> =>
  record.kind === 'character' ? characterAssetMediaTypes : cadAssetMediaTypes;
/** Asset refs named by the draft, every retained version and the part versions they place. */
export function cadClosure(record: StoredArtifact): Map<string, CadAssetRef> {
  const refs = new Map<string, CadAssetRef>();
  for (const content of contents(record))
    for (const ref of content.assets ?? []) refs.set(key(ref.kind, ref.sha256), ref);
  return refs;
}

export function encodeBytes(bytes: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
}
export function decodeBytes(text: string): Uint8Array {
  // A character class, not a repeated group: the regex stack must not grow with the asset.
  if (typeof text !== 'string' || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw new Error('CAD resource encoding');
  const raw = atob(text);
  if (btoa(raw) !== text) throw new Error('CAD resource encoding');
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
export async function sha256Ref(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The record a native file carries: the CAD resources the draft and versions name, nothing
 * else. Unreferenced bytes (a cancelled insert, an Undo in this session) stay local only.
 */
export function portableCadRecord(record: StoredArtifact): StoredArtifact {
  if (!keepsAssets(record)) return record;
  const closure = cadClosure(record);
  const cadResources = (record.cadResources ?? []).filter((r) =>
    closure.has(key(r.kind, r.sha256)),
  );
  // A building's placed versions are kept by `portableBimRecord`; a character's props reach
  // only the versions its draft and versions place.
  if (record.kind === 'bim') return record.cadResources ? { ...record, cadResources } : record;
  if (record.kind === 'character')
    return portableCharacterRecord(record.cadResources ? { ...record, cadResources } : record);
  // Part versions the draft and versions no longer place stay local only, like assets.
  const reached = cadPartClosure(record).reached;
  return {
    ...record,
    cadResources,
    ...(record.cadParts
      ? { cadParts: record.cadParts.filter((p) => reached.has(p.contentHash)) }
      : {}),
  };
}
export const nativeBytes = (record: StoredArtifact) =>
  new TextEncoder().encode(serializeArtifact(record)).length;
/**
 * A CAD record whose native file would no longer import is refused before a version is saved
 * (each adds a content snapshot) and before a native export is downloaded (ordinary edits grow
 * the draft too), so a file is never written that the Playground cannot read back.
 */
export function assertCadNativeFits(record: StoredArtifact, action: 'version' | 'export') {
  if (record.kind !== 'cad' && record.kind !== 'character') return;
  const size = nativeBytes(portableCadRecord(record));
  if (size <= cadNativeLimit.bytes) return;
  const mb = `native fileが${(size / 1e6).toFixed(1)} MBになり、上限の${cadNativeLimitText()}を超えます`;
  throw new Error(
    action === 'version'
      ? `Versionを保存すると${mb}。保存しません。下書きは保持しています。`
      : `${mb}。読み戻せないfileになるため書き出しません。Undoで最近の編集を戻すか、bodyを減らすと書き出せます。下書きは保持しています。`,
  );
}

/**
 * Native import and stored-record check: every resource decodes to its size and hash with the
 * media type of its kind, once per kind and hash, and the closure is exact: every ref of the
 * draft and every version resolves, and nothing else is carried.
 */
export async function validateCadRecord(record: StoredArtifact) {
  if (record.kind === 'cad') validateCadParts(record);
  const resources = record.cadResources ?? [];
  if (!Array.isArray(resources)) throw new Error('CAD resources');
  const seen = new Map<string, CadResource>();
  const mediaTypes = mediaTypesOf(record);
  for (const r of resources) {
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).sort().join() !== 'byteLength,bytes,encoding,kind,mediaType,sha256' ||
      r.encoding !== 'base64' ||
      typeof r.kind !== 'string' ||
      !Object.hasOwn(mediaTypes, r.kind) ||
      r.mediaType !== mediaTypes[r.kind]
    )
      throw new Error('CAD resource');
    if (seen.has(key(r.kind, r.sha256))) throw new Error('CAD resource duplicated');
    const bytes = decodeBytes(r.bytes);
    if (bytes.length !== r.byteLength || (await sha256Ref(bytes)) !== r.sha256)
      throw new Error('CAD resource hash mismatch');
    seen.set(key(r.kind, r.sha256), r);
  }
  // Every ref of every content, not the deduplicated closure: a draft and a version that name
  // the same hash with different metadata must not hide one another.
  for (const content of contents(record))
    for (const ref of content.assets ?? []) {
      const r = seen.get(key(ref.kind, ref.sha256));
      if (!r) throw new Error('CAD resource missing');
      if (r.byteLength !== ref.byteLength || r.mediaType !== ref.mediaType)
        throw new Error('CAD resource does not match its ref');
    }
  if (seen.size !== cadClosure(record).size) throw new Error('CAD resource not referenced');
}

/**
 * The CAD assets of a record written from `saved` while `latest` may have staged more:
 * both sets, by hash, so a save that overlaps staging never drops stored bytes.
 */
export function mergeCadResources(
  saved: { cadResources?: CadResource[] },
  latest: { cadResources?: CadResource[] },
): { cadResources?: CadResource[] } {
  if (!saved.cadResources && !latest.cadResources) return {};
  const merged = [...(latest.cadResources ?? [])];
  for (const r of saved.cadResources ?? [])
    if (!merged.some((m) => m.sha256 === r.sha256)) merged.push(r);
  return { cadResources: merged };
}

/**
 * The CAD Surface's asset store over one stored record. `stage` checks each file's hash and
 * size, refuses when the native file would pass the limit, and resolves only after the record
 * holding the bytes is saved; the content names them afterwards, in its own edit.
 */
export function createCadAssetStore(options: {
  record(): StoredArtifact | undefined;
  persist(record: StoredArtifact): Promise<boolean>;
  /** The record its native file carries; a building's also drops versions it no longer places. */
  portable?(record: StoredArtifact): StoredArtifact;
}): CadAssetStore {
  const portableOf = options.portable ?? portableCadRecord;
  const decoded = new Map<string, Uint8Array>();
  return {
    get(sha256) {
      const cached = decoded.get(sha256);
      if (cached) return cached;
      const r = options.record()?.cadResources?.find((x) => x.sha256 === sha256);
      if (!r) return undefined;
      const bytes = decodeBytes(r.bytes);
      decoded.set(sha256, bytes);
      return bytes;
    },
    async stage(assets) {
      for (const { ref, bytes } of assets)
        if (bytes.length !== ref.byteLength || (await sha256Ref(bytes)) !== ref.sha256)
          throw new Error('（データが記録と一致しません）');
      // Read the latest record after the last await, so a newer draft is never overwritten.
      const record = options.record();
      if (!record) throw new Error('（保存先の文書がありません）');
      const resources = [...(record.cadResources ?? [])];
      for (const { ref, bytes } of assets) {
        if (!resources.some((r) => r.kind === ref.kind && r.sha256 === ref.sha256))
          resources.push({
            kind: ref.kind,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            mediaType: ref.mediaType,
            encoding: 'base64',
            bytes: encodeBytes(bytes),
          });
      }
      // Measured with the real serializer: the native file after the insert must stay importable.
      const portable = portableOf(record);
      const named = new Set(assets.map((a) => key(a.ref.kind, a.ref.sha256)));
      const size = nativeBytes({
        ...portable,
        cadResources: [
          ...(portable.cadResources ?? []),
          ...resources.filter(
            (r) =>
              named.has(key(r.kind, r.sha256)) &&
              !portable.cadResources?.some((p) => p.kind === r.kind && p.sha256 === r.sha256),
          ),
        ],
      });
      if (size + cadInsertReserveBytes > cadNativeLimit.bytes)
        throw new Error(
          `（native fileが${(size / 1e6).toFixed(1)} MBになり、上限の${cadNativeLimitText()}を超えます）`,
        );
      if (!(await options.persist({ ...record, cadResources: resources })))
        throw new Error('（ブラウザへの保存に失敗しました）');
      for (const { ref, bytes } of assets) decoded.set(ref.sha256, bytes);
    },
  };
}
