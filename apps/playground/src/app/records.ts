import { verifyFictionMapArtifact } from '@editor-platform/fiction-map/host';
import { verifyPlaygroundEstimate as verifyEstimateArtifact } from './estimate-bim';
import { verifyAnalysisArtifact } from '@editor-platform/analysis/host';
import {
  contentHash,
  deepFreeze,
  IndexedDBStorage,
  type OutOfLineParts,
} from '@editor-platform/artifact-core';
import { graphSchemaMessage, readGraphDocument } from '@editor-platform/structured-graph/model';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import { validateArtifactReferenceHistory } from '../artifact-references';
import { validateGeoRecord } from '../geo/resources';
import { validateSimulationSources } from '../simulation/source';
import { validateConstructionSources } from '../construction/source';
import { validateFactorySources } from '../factory/source';
import { validateFactoryLooks } from '../factory/looks';
import { validateDrawingSources } from '../drawing/sources';
import { createLocalSession, validContent, type Content, type StoredArtifact } from '../model';

/** A resource's bytes from this length on are kept as their own IndexedDB value (#812). */
export const resourcePartChars = 64 * 1024;
/**
 * #1292: Chromium refuses one IndexedDB value over 133,169,152 bytes, so bytes longer than
 * `single` (well below that, with room for the value's own overhead) are written as several
 * values of `chars` each, under the part key and `#0`, `#1` and so on. A part written before
 * #1292 is one value of up to `legacy` characters under the part key alone, so bytes of a
 * length between `single` and `legacy` are read from either form (Codex on #1307). The chunk
 * count comes from the stub's `byteLength` (base64 is `4 × ceil(byteLength / 3)` characters),
 * so these numbers may not change once records use them. Unit tests lower them to keep their
 * records small; nothing else changes them.
 */
export const resourceChunks = {
  single: 96 * 1024 * 1024,
  chars: 64 * 1024 * 1024,
  legacy: 133_169_152,
};
const base64Chars = (byteLength: number) => 4 * Math.ceil(byteLength / 3);
const chunked = (key: string, chars: number) =>
  Array.from({ length: Math.ceil(chars / resourceChunks.chars) }, (_, i) => `${key}#${i}`);
/** The keys one payload is written under: its own key, or one per chunk. */
const chunkKeys = (key: string, chars: number) =>
  chars <= resourceChunks.single ? [key] : chunked(key, chars);
/** The keys one payload may have been written under, the form written now first. */
const readKeys = (key: string, chars: number) =>
  chars <= resourceChunks.single
    ? [key]
    : chars <= resourceChunks.legacy
      ? [...chunked(key, chars), key]
      : chunked(key, chars);
const resourcePartKey = (r: { kind: string; sha256: string }) =>
  `cad-resource:${r.kind}:${r.sha256}`;
type Inline = { bytes: string; byteLength: number; sha256: string; kind?: string };
/**
 * The record's large byte payloads, each with its part key: CAD assets, and a drawing's kept
 * source assets and issued PDFs (Codex on #1278). Each field has its own key space, so the same
 * bytes kept twice never share one part.
 */
const payloads: {
  key(r: Inline): string;
  read(v: StoredArtifact): readonly Inline[] | undefined;
  write(v: StoredArtifact, map: (r: Inline) => Inline): StoredArtifact;
}[] = [
  {
    key: (r) => resourcePartKey({ kind: r.kind ?? '', sha256: r.sha256 }),
    read: (v) => v.cadResources,
    write: (v, map) =>
      v.cadResources ? { ...v, cadResources: v.cadResources.map((r) => map(r) as typeof r) } : v,
  },
  {
    key: (r) => `drawing-asset:${r.kind}:${r.sha256}`,
    read: (v) => v.drawingAssets,
    write: (v, map) =>
      v.drawingAssets ? { ...v, drawingAssets: v.drawingAssets.map((r) => map(r) as typeof r) } : v,
  },
  {
    key: (r) => `drawing-issue:${r.sha256}`,
    read: (v) => v.drawingIssues?.map((i) => i.pdf),
    write: (v, map) =>
      v.drawingIssues
        ? {
            ...v,
            drawingIssues: v.drawingIssues.map((i) => ({
              ...i,
              pdf: map(i.pdf) as typeof i.pdf,
            })),
          }
        : v,
  },
];

/**
 * #812: Chromium stores one IndexedDB value up to about 133 MB, below the native limit
 * (`cadNativeLimit`), so a record's large asset bytes are stored apart from it, and bytes too
 * long for one value in several chunks (#1292). In the stub such a resource keeps
 * its metadata and an empty `bytes`; a missing part leaves it empty, and the resource checks
 * then refuse it like any other damaged asset.
 */
export const resourceParts: OutOfLineParts<StoredArtifact> = {
  split(value) {
    const parts = new Map<string, unknown>();
    let stub = value;
    for (const p of payloads) {
      if (!p.read(stub)?.some((r) => r.bytes.length >= resourcePartChars)) continue;
      stub = p.write(stub, (r) => {
        if (r.bytes.length < resourcePartChars) return r;
        chunkKeys(p.key(r), r.bytes.length).forEach((key, i, all) =>
          parts.set(
            key,
            all.length === 1
              ? r.bytes
              : r.bytes.slice(i * resourceChunks.chars, (i + 1) * resourceChunks.chars),
          ),
        );
        return { ...r, bytes: '' };
      });
    }
    return { stub, parts };
  },
  keys(stub) {
    return payloads.flatMap((p) =>
      (p.read(stub) ?? [])
        .filter((r) => r.bytes === '' && r.byteLength > 0)
        .flatMap((r) => readKeys(p.key(r), base64Chars(r.byteLength))),
    );
  },
  join(stub, parts) {
    let value = stub;
    for (const p of payloads) {
      if (!p.read(value)?.some((r) => r.bytes === '')) continue;
      value = p.write(value, (r) => {
        if (r.bytes !== '') return r;
        const key = p.key(r);
        const chars = base64Chars(r.byteLength);
        const whole = parts.get(key);
        // A part written before #1292 as one value.
        if (chars > resourceChunks.single && typeof whole === 'string')
          return { ...r, bytes: whole };
        const chunks = chunkKeys(key, chars).map((k) => parts.get(k));
        // A missing chunk leaves the bytes empty, the same as a missing part.
        if (!chunks.every((c): c is string => typeof c === 'string')) return r;
        return { ...r, bytes: chunks.join('') };
      });
    }
    return value;
  },
};
export const storage = new IndexedDBStorage<StoredArtifact>('editor-platform', resourceParts);

// Session results are caller-owned snapshots. The Host adopts this result rather
// than defensively cloning the entire draft a second time before IndexedDB clones it.
export function editedDraft(record: StoredArtifact, content: Content): StoredArtifact {
  return { ...record, draft: { ...record.draft, content, updatedAt: new Date().toISOString() } };
}

/** Validates a stored record (freezing its versions) and opens its local draft session. */
export async function openStoredRecord(record: StoredArtifact, references: ReferenceResolver) {
  if (!validContent(record.kind, record.draft.content))
    throw new Error(
      // A newer Graph schema gets its own reason; the record stays exportable.
      record.kind === 'structured-graph'
        ? graphSchemaMessage(record.draft.content)
        : 'Invalid stored content',
    );
  if (record.versions.some((v) => !validContent(record.kind, v.content)))
    throw new Error('Invalid stored version');
  if (
    record.kind === 'design' ||
    record.kind === 'estimate' ||
    record.kind === 'analysis' ||
    record.kind === 'structured-graph' ||
    record.kind === 'animation' ||
    record.kind === 'cad' ||
    record.kind === 'bim' ||
    record.kind === 'character' ||
    record.kind === 'simulation' ||
    record.kind === 'construction' ||
    record.kind === 'pcb' ||
    record.kind === 'schematic' ||
    record.kind === 'ladder' ||
    record.kind === 'cosim' ||
    record.kind === 'drawing' ||
    record.kind === 'factory'
  ) {
    for (const v of record.versions)
      if ((await contentHash(v.content)) !== v.contentHash)
        throw new Error('Stored version hash mismatch');
  }
  if (record.kind === 'fiction-map') await verifyFictionMapArtifact(record);
  if (record.kind === 'geo') await validateGeoRecord(record);
  if (record.kind === 'simulation') validateSimulationSources(record, { stored: true });
  if (record.kind === 'construction') validateConstructionSources(record, { stored: true });
  if (record.kind === 'factory') {
    validateFactorySources(record, { stored: true });
    validateFactoryLooks(record, { stored: true });
  }
  if (record.kind === 'drawing') validateDrawingSources(record, { stored: true });
  await verifyAnalysisArtifact(record);
  await verifyEstimateArtifact(record);
  record.versions.forEach(deepFreeze);
  await validateArtifactReferenceHistory(record, references);
  // An older Graph schema opens as the current one; its saved versions are not rewritten.
  return createLocalSession(
    record.kind === 'structured-graph'
      ? (readGraphDocument(record.draft.content) as unknown as Content)
      : record.draft.content,
  );
}
