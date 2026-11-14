import type { CharacterAssetRef, CharacterDocument } from '@editor-platform/character-core';
import type { StoredArtifact } from '../model';
import {
  cadClosure,
  cadInsertReserveBytes,
  cadNativeLimit,
  cadNativeLimitText,
  encodeBytes,
  nativeBytes,
  portableCadRecord,
  type CadResource,
} from '../cad/resources';

const key = (r: { kind: string; sha256: string }) => `${r.kind} ${r.sha256}`;

/**
 * The record that keeps a new mesh asset of a C3 edit, before the edit names it.
 *
 * Every mesh edit adds a whole new mesh, so the record would only grow. The record keeps only
 * the assets something can still reach: the draft, every saved version, the current content and
 * the session's Undo and Redo entries, plus the new one. When even that would pass the limit a
 * stored record can hold, the oldest Undo entries are given up (`forget` of them), never the
 * versions or the content; when the native file itself (draft and versions, with the new asset)
 * would pass it, the edit is refused. Nothing is changed when it is refused.
 */
export function characterMeshRecord(input: {
  record: StoredArtifact;
  content: CharacterDocument;
  undo: readonly CharacterDocument[];
  redo: readonly CharacterDocument[];
  ref: CharacterAssetRef;
  bytes: Uint8Array;
  /** C7b: more assets of the same edit (a multires stroke's chunks), kept in the same write. */
  more?: readonly { ref: CharacterAssetRef; bytes: Uint8Array }[];
}): { record: StoredArtifact; forget: number } {
  const { record, content, undo, redo } = input;
  const all = [{ ref: input.ref, bytes: input.bytes }, ...(input.more ?? [])];
  const resources: CadResource[] = all.map(({ ref, bytes }) => ({
    kind: ref.kind as unknown as CadResource['kind'],
    sha256: ref.sha256,
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    encoding: 'base64',
    bytes: encodeBytes(bytes),
  }));
  const withNew = [...(record.cadResources ?? [])];
  for (const r of resources) if (!withNew.some((k) => key(k) === key(r))) withNew.push(r);
  // The native file after the edit: the draft names the new assets (its part entry is in the
  // reserve), the versions are unchanged.
  const draft = { ...content, assets: [...content.assets, ...all.map((a) => a.ref)] };
  const after = { ...record, draft: { ...record.draft, content: draft } } as StoredArtifact;
  const portable = nativeBytes(portableCadRecord({ ...after, cadResources: withNew }));
  if (portable + cadInsertReserveBytes > cadNativeLimit.bytes)
    throw new Error(
      `the native file would be ${(portable / 1e6).toFixed(1)} MB, over the ${cadNativeLimitText()} limit`,
    );
  // The stored record with the history from the n-th oldest Undo entry on.
  const fixed = new Set<string>([...cadClosure(after).keys(), ...cadClosure(record).keys()]);
  for (const doc of [content, ...redo]) for (const a of doc.assets) fixed.add(key(a));
  const storedWith = (n: number) => {
    const reach = new Set(fixed);
    for (const doc of undo.slice(n)) for (const a of doc.assets) reach.add(key(a));
    const cadResources = withNew.filter((r) => reach.has(key(r)));
    const next = { ...record, cadResources } as StoredArtifact;
    return { next, size: nativeBytes(next) };
  };
  for (let n = 0; n <= undo.length; n++) {
    const { next, size } = storedWith(n);
    if (size + cadInsertReserveBytes <= cadNativeLimit.bytes) return { record: next, forget: n };
  }
  throw new Error(
    `the stored record would pass the ${cadNativeLimitText()} limit even without Undo history`,
  );
}
