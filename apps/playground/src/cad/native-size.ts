/**
 * The CAD native-file byte counter (docs/cad/model.md, 総容量admission; CAD23). It gives the
 * exact UTF-8 byte count of `serializeArtifact(portableCadRecord(record))` without building
 * that string: each content is encoded once and its count kept, asset bytes count by their
 * stored length, and only the small envelope (names, version metadata, asset metadata) is
 * serialized again for each check.
 */
import { serializeArtifact } from '@editor-platform/artifact-core';
import type { CadDocument } from '@editor-platform/cad-core';
import type { StoredArtifact } from '../model';
import { cadNativeFileBytes, portableCadRecord } from './resources';

/** Bumped whenever `serializeArtifact` changes how it writes a record; receipts then expire. */
export const cadNativeCodecVersion = 1;
/** Counts kept by content hash, independent of the session history (least recently used out). */
export const cadCountCacheEntries = 1024;

/** One content encoded alone at the top level: its bytes and its line breaks. */
interface Fragment {
  bytes: number;
  newlines: number;
}
/** A candidate counted while it evaluates, checked again directly before it applies. */
export interface CadSizeReceipt {
  candidateHash: string;
  codecVersion: number;
  fragment: Fragment;
}

export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

function encodeFragment(content: unknown): Fragment {
  // The same indentation as serializeArtifact; nesting only adds spaces after line breaks.
  const json = JSON.stringify(content, null, 2);
  let newlines = 0;
  for (let i = json.indexOf('\n'); i !== -1; i = json.indexOf('\n', i + 1)) newlines++;
  return { bytes: utf8Length(json), newlines };
}
const base64Length = (byteLength: number) => 4 * Math.ceil(byteLength / 3);

export class CadNativeCounter {
  private byHash = new Map<string, Fragment>();
  /** Frozen contents already counted (versions and applied drafts). Released with the object. */
  private byObject = new WeakMap<object, Fragment>();
  /** Contents encoded since construction: tests check that a check re-encodes nothing. */
  encoded = 0;
  private counts = 0;

  private remember(hash: string, fragment: Fragment) {
    this.byHash.delete(hash);
    this.byHash.set(hash, fragment);
    for (const key of this.byHash.keys()) {
      if (this.byHash.size <= cadCountCacheEntries) break;
      this.byHash.delete(key);
    }
  }
  private fragment(content: CadDocument, hash?: string): Fragment {
    const known =
      this.byObject.get(content) ?? (hash !== undefined ? this.byHash.get(hash) : undefined);
    if (known) {
      if (hash !== undefined) this.remember(hash, known);
      return known;
    }
    const fragment = encodeFragment(content);
    this.encoded++;
    if (Object.isFrozen(content)) this.byObject.set(content, fragment);
    if (hash !== undefined) this.remember(hash, fragment);
    return fragment;
  }

  /** Counts a candidate. Async so a Host may move it off the input task; the work is the same. */
  async prepare(candidate: CadDocument, candidateHash: string): Promise<CadSizeReceipt> {
    return {
      candidateHash,
      codecVersion: cadNativeCodecVersion,
      fragment: this.fragment(candidate, candidateHash),
    };
  }

  /**
   * Exact native bytes of the record's portable file. `draft` is a candidate counted by its
   * receipt, written as the record's edited draft (its asset closure included).
   */
  count(record: StoredArtifact, draft?: { content: CadDocument; fragment: Fragment }): number {
    // As the Host writes an edited draft (apps/playground/src/app/records.ts, editedDraft).
    const edited: StoredArtifact = draft
      ? {
          ...record,
          draft: { ...record.draft, content: draft.content, updatedAt: new Date().toISOString() },
        }
      : record;
    const portable = portableCadRecord(edited);
    // Placeholders carry a fresh nonce, so names and other metadata cannot spell them; each must
    // still appear exactly once, or the record is serialized in full.
    const nonce = `${++this.counts}-${Math.random().toString(36).slice(2)}`;
    const slots: Fragment[] = [];
    const slot = (fragment: Fragment) => `\u0000cad-native-${nonce}-${slots.push(fragment) - 1}`;
    const resources: number[] = [];
    const skeleton: StoredArtifact = {
      ...portable,
      draft: {
        ...portable.draft,
        content: slot(
          draft?.fragment ?? this.fragment(portable.draft.content as CadDocument),
        ) as never,
      },
      versions: portable.versions.map((v) => ({
        ...v,
        content: slot(this.fragment(v.content as CadDocument)) as never,
      })),
      // The retained part closure (R2b-1) counts by content hash like the versions.
      ...(portable.cadParts
        ? {
            cadParts: portable.cadParts.map((p) => ({
              ...p,
              content: slot(this.fragment(p.content, p.contentHash)) as never,
            })),
          }
        : {}),
      ...(portable.cadResources
        ? {
            cadResources: portable.cadResources.map((r) => {
              // Stored base64 is ASCII without escapes; a length that does not match its size
              // is counted from the string itself.
              resources.push(
                r.bytes.length === base64Length(r.byteLength)
                  ? r.bytes.length + 2
                  : utf8Length(JSON.stringify(r.bytes)),
              );
              return { ...r, bytes: `\u0000cad-asset-${nonce}-${resources.length - 1}` };
            }),
          }
        : {}),
    };
    const json = serializeArtifact(skeleton);
    const placeholders = [
      ...slots.map((_, i) => JSON.stringify(`\u0000cad-native-${nonce}-${i}`)),
      ...resources.map((_, i) => JSON.stringify(`\u0000cad-asset-${nonce}-${i}`)),
    ];
    if (placeholders.some((p) => json.indexOf(p) !== json.lastIndexOf(p)))
      return utf8Length(serializeArtifact(portable));
    let total = utf8Length(json);
    slots.forEach((fragment, i) => {
      const placeholder = placeholders[i]!;
      const at = json.indexOf(placeholder);
      // The line's indentation is the depth the content is written at: every line break inside
      // it gains that many spaces.
      const indent = at - json.lastIndexOf('\n', at) - 1 - '"content": '.length;
      total += fragment.bytes + fragment.newlines * indent - placeholder.length;
    });
    resources.forEach((bytes, i) => {
      total += bytes - placeholders[slots.length + i]!.length;
    });
    return total;
  }

  /**
   * Admission directly before a candidate applies: the latest record (with a version save in
   * progress, the record that save writes) with the candidate as its draft. Returns the refused
   * size, or undefined when it fits.
   */
  admit(
    receipt: CadSizeReceipt,
    candidate: CadDocument,
    record: StoredArtifact,
  ): number | undefined {
    const fragment =
      receipt.codecVersion === cadNativeCodecVersion
        ? receipt.fragment
        : this.fragment(candidate, receipt.candidateHash);
    const size = this.count(record, { content: candidate, fragment });
    return size > cadNativeFileBytes ? size : undefined;
  }

  /** The same admission for content that has no receipt: Undo, Redo and restore. */
  admitContent(record: StoredArtifact, content: CadDocument): number | undefined {
    const size = this.count(record, { content, fragment: this.fragment(content) });
    return size > cadNativeFileBytes ? size : undefined;
  }
}

/** One counter per page: its cache is keyed by content, so Artifacts share it safely. */
export const cadNativeCounter = new CadNativeCounter();

/** Refuses Undo, Redo or restore of CAD content that would not fit the native file. */
export function assertCadContentFits(record: StoredArtifact, content: CadDocument, action: string) {
  const size = cadNativeCounter.admitContent(record, content);
  if (size !== undefined)
    throw new Error(
      `${action}と、native fileが${(size / 1e6).toFixed(1)} MBになり、上限の16 MBを超えます。内容は変えていません。`,
    );
}
