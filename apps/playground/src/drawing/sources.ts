/**
 * DW1 (docs/cad/drawing-editor.md, 元の版の保持; DW-U2): the CAD and building versions a drawing
 * sees, kept by content hash beside the record so the drawing shows on its own wherever it goes.
 * The closure follows a CAD assembly's placed part versions (nested ones included) and the CAD
 * part versions a building places. DW3c-2: the asset bytes those CAD versions name (STEP
 * originals, normalized BReps, kept PMI) are kept too (`drawingAssets`), so imported geometry
 * evaluates from the drawing's own copy.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  cadAssetMediaTypes,
  cadContentHash,
  isCadDocument,
  type CadDocument,
} from '@editor-platform/cad-core';
import { bimContentHash, isBimDocument, type BimDocument } from '@editor-platform/bim-core';
import { drawingLimits, type DrawingDocument } from '@editor-platform/drawing-core';
import type { DrawingIssueRecord, StoredArtifact } from '../model';
import { decodeBytes, encodeBytes, type CadResource } from '../cad/resources';

export type DrawingSourceRecord =
  | { kind: 'cad'; contentHash: string; content: CadDocument }
  | { kind: 'bim'; contentHash: string; content: BimDocument };

/** Imported geometry: evaluating it needs the asset bytes the drawing keeps beside it. */
export const drawingImportsGeometry = (content: CadDocument) =>
  content.assets.some((a) => a.kind === 'source-step' || a.kind === 'normalized-brep');

const assetKey = (kind: string, sha: string) => `${kind} ${sha}`;
/**
 * The asset refs every kept CAD version the drawing reaches names, by kind and hash: each
 * version's own ref, since two versions may name one asset with different metadata.
 */
function assetClosure(reached: ReadonlyMap<string, DrawingSourceRecord>) {
  const out = new Map<string, CadDocument['assets'][number][]>();
  for (const r of reached.values())
    if (r.kind === 'cad')
      for (const a of (r.content as CadDocument).assets) {
        const k = assetKey(a.kind, a.sha256);
        out.set(k, [...(out.get(k) ?? []), a]);
      }
  return out;
}
/** The asset refs of the versions drawn as CAD (a version only a building places has none). */
const drawingAssetClosure = (
  reached: ReadonlyMap<string, DrawingSourceRecord>,
  drawn: ReadonlySet<string>,
) => assetClosure(new Map([...reached].filter(([h]) => drawn.has(h))));
const hashOf = (r: Pick<DrawingSourceRecord, 'kind' | 'content'>) =>
  r.kind === 'cad'
    ? cadContentHash(r.content as CadDocument)
    : bimContentHash(r.content as BimDocument);

/** The versions a content needs besides itself: placed CAD parts (assembly or building). */
function children(r: Pick<DrawingSourceRecord, 'kind' | 'content'>): string[] {
  if (r.kind === 'cad')
    return (r.content as CadDocument).parts?.map((p) => p.source.contentHash) ?? [];
  return (r.content as BimDocument).types.flatMap((t) =>
    t.kind === 'part' ? [t.source.contentHash] : [],
  );
}

const roots = (record: Pick<StoredArtifact, 'draft' | 'versions'>) =>
  [record.draft.content, ...record.versions.map((v) => v.content)] as DrawingDocument[];

/**
 * The kept versions reachable from the draft and every version, by hash; hashes the record does
 * not keep are `missing`. A view's source must be of its declared kind; a placed part is CAD.
 */
export function drawingSourceClosure(
  record: Pick<StoredArtifact, 'draft' | 'versions' | 'drawingSources'>,
) {
  const kept = new Map((record.drawingSources ?? []).map((p) => [p.contentHash, p]));
  const reached = new Map<string, DrawingSourceRecord>();
  const missing = new Set<string>();
  const wrongKind = new Set<string>();
  const visit = (hash: string, kind: 'cad' | 'bim') => {
    if (reached.has(hash)) {
      if (reached.get(hash)!.kind !== kind) wrongKind.add(hash);
      return;
    }
    if (missing.has(hash)) return;
    const r = kept.get(hash);
    if (!r) return void missing.add(hash);
    if (r.kind !== kind) wrongKind.add(hash);
    reached.set(hash, r);
    for (const c of children(r)) visit(c, 'cad');
  };
  for (const doc of roots(record)) for (const s of doc.sources) visit(s.contentHash, s.kind);
  // The CAD versions drawn as CAD (a view's, or a part of one), whose asset bytes are kept; a
  // version only a building places is drawn without them.
  const drawn = new Set<string>();
  const mark = (hash: string) => {
    const r = reached.get(hash);
    if (drawn.has(hash) || r?.kind !== 'cad') return;
    drawn.add(hash);
    for (const c of children(r)) mark(c);
  };
  for (const doc of roots(record))
    for (const s of doc.sources) if (s.kind === 'cad') mark(s.contentHash);
  return { reached, missing, wrongKind, drawn };
}

/**
 * Native import and stored-record check: each kept version is valid content of its kind under
 * its own hash, once, without imported geometry; every version the draft and versions reach is
 * kept. An import keeps exactly those; a stored record may also keep versions switched away from
 * (`stored`), which the export leaves out (`portableDrawingRecord`).
 */
export function validateDrawingSources(
  record: Pick<
    StoredArtifact,
    'draft' | 'versions' | 'drawingSources' | 'drawingAssets' | 'drawingIssues'
  >,
  { stored = false }: { stored?: boolean } = {},
) {
  validateDrawingIssues(record);
  const kept = record.drawingSources ?? [];
  if (!Array.isArray(kept)) throw new Error('Drawing sources');
  if (kept.length > drawingLimits.sources * 20) throw new Error('Drawing sources limit');
  const hashes = new Set<string>();
  for (const p of kept as unknown[]) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash,kind' ||
      typeof (p as DrawingSourceRecord).contentHash !== 'string'
    )
      throw new Error('Drawing source');
    const r = p as DrawingSourceRecord;
    if (hashes.has(r.contentHash)) throw new Error('Drawing source duplicated');
    hashes.add(r.contentHash);
    if (r.kind === 'cad') {
      if (!isCadDocument(r.content)) throw new Error('Drawing source content');
    } else if (r.kind === 'bim') {
      if (!isBimDocument(r.content)) throw new Error('Drawing source content');
    } else throw new Error('Drawing source kind');
    if (hashOf(r) !== r.contentHash) throw new Error('Drawing source hash mismatch');
  }
  const { reached, missing, wrongKind, drawn } = drawingSourceClosure(record);
  if (missing.size) throw new Error('Drawing source missing');
  if (wrongKind.size) throw new Error('Drawing source kind');
  if (!stored && reached.size !== hashes.size) throw new Error('Drawing source not referenced');
  validateDrawingAssets(record.drawingAssets, drawingAssetClosure(reached, drawn), stored);
}

/**
 * DW3c-2: every kept asset decodes to its size and hash with its kind's media type, once; every
 * asset ref of every reached CAD version is matched by the kept bytes' size and type; an import keeps only
 * those (a stored record may keep more, which the export leaves out).
 */
function validateDrawingAssets(
  kept: unknown,
  needed: ReadonlyMap<string, CadDocument['assets'][number][]>,
  stored: boolean,
) {
  if (kept === undefined) {
    if (needed.size) throw new Error('Drawing asset missing');
    return;
  }
  if (!Array.isArray(kept)) throw new Error('Drawing assets');
  const seen = new Map<string, CadResource>();
  for (const r of kept as CadResource[]) {
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).sort().join() !== 'byteLength,bytes,encoding,kind,mediaType,sha256' ||
      r.encoding !== 'base64' ||
      !Object.hasOwn(cadAssetMediaTypes, r.kind) ||
      r.mediaType !== cadAssetMediaTypes[r.kind as keyof typeof cadAssetMediaTypes]
    )
      throw new Error('Drawing asset');
    if (seen.has(assetKey(r.kind, r.sha256))) throw new Error('Drawing asset duplicated');
    const bytes = decodeBytes(r.bytes);
    if (bytes.length !== r.byteLength || `sha256:${bytesToHex(sha256(bytes))}` !== r.sha256)
      throw new Error('Drawing asset hash mismatch');
    seen.set(assetKey(r.kind, r.sha256), r);
  }
  for (const [k, refs] of needed) {
    const r = seen.get(k);
    if (!r) throw new Error('Drawing asset missing');
    // Every version naming it: each must evaluate from these bytes.
    for (const ref of refs)
      if (r.byteLength !== ref.byteLength || r.mediaType !== ref.mediaType)
        throw new Error('Drawing asset does not match its ref');
  }
  if (!stored && seen.size !== needed.size) throw new Error('Drawing asset not referenced');
}

/** The record as exported: only the versions its draft and versions reach, and their assets. */
export function portableDrawingRecord<
  T extends Pick<
    StoredArtifact,
    'kind' | 'draft' | 'versions' | 'drawingSources' | 'drawingAssets'
  >,
>(record: T): T {
  if (record.kind !== 'drawing' || !record.drawingSources) return record;
  const { reached, drawn } = drawingSourceClosure(record);
  const assets = drawingAssetClosure(reached, drawn);
  return {
    ...record,
    drawingSources: record.drawingSources.filter((p) => reached.has(p.contentHash)),
    ...(record.drawingAssets
      ? {
          drawingAssets: record.drawingAssets.filter((a) => assets.has(assetKey(a.kind, a.sha256))),
        }
      : {}),
  };
}

/**
 * The record with `versions` kept (by hash, once), before an edit names them: a view's source
 * and, for an assembly or a building, every part version it places (from `lookup`, the CAD
 * versions the Host knows), with the asset bytes each CAD version names (from `asset`, the bytes
 * the Host keeps). Refuses a placed version or an asset the Host cannot find.
 */
export function stageDrawingSources<
  T extends Pick<StoredArtifact, 'drawingSources' | 'drawingAssets'>,
>(
  record: T,
  versions: readonly Pick<DrawingSourceRecord, 'kind' | 'content'>[],
  lookup: (contentHash: string) => CadDocument | undefined,
  asset: (kind: string, sha256: string) => CadResource | undefined = () => undefined,
): T {
  const kept = [...(record.drawingSources ?? [])];
  const have = new Set(kept.map((p) => p.contentHash));
  const assets = [...(record.drawingAssets ?? [])];
  const haveAssets = new Set(assets.map((a) => assetKey(a.kind, a.sha256)));
  // `placed`: a CAD version only a building places. A building keeps no asset bytes of the
  // versions it places (it draws them without their textures), and neither does the drawing:
  // the building is kept without them rather than refused (Codex on #1237).
  const done = new Set<string>();
  const add = (r: Pick<DrawingSourceRecord, 'kind' | 'content'>, placed = false) => {
    if (r.kind === 'cad')
      for (const ref of (r.content as CadDocument).assets) {
        const k = assetKey(ref.kind, ref.sha256);
        if (haveAssets.has(k)) continue;
        if (placed) break;
        const bytes = asset(ref.kind, ref.sha256);
        if (!bytes) throw new Error('source-assets');
        haveAssets.add(k);
        assets.push(bytes);
      }
    const contentHash = hashOf(r);
    if (!have.has(contentHash)) {
      have.add(contentHash);
      kept.push({ ...r, contentHash, content: structuredClone(r.content) } as DrawingSourceRecord);
    } else if (placed || r.kind !== 'cad' || done.has(contentHash)) return;
    // Its closure walked once for its bytes, however many paths reach it (Codex on #1237).
    if (r.kind === 'cad' && !placed) done.add(contentHash);
    // A version kept already (only a building placed it, without its bytes) and now drawn as CAD
    // still has its parts' bytes added (Codex on #1237).
    const under = placed || r.kind === 'bim';
    for (const c of children(r)) {
      if (have.has(c) && under) continue;
      const content =
        (kept.find((k) => k.contentHash === c)?.content as CadDocument | undefined) ?? lookup(c);
      if (!content) throw new Error('source-missing');
      add({ kind: 'cad', content }, under);
    }
  };
  versions.forEach((v) => add(v));
  return {
    ...record,
    drawingSources: kept,
    ...(assets.length ? { drawingAssets: assets } : {}),
  };
}

/** The kept content of a hash, if the record keeps it. */
export const drawingSourceOf = (
  record: Pick<StoredArtifact, 'drawingSources'> | undefined,
  contentHash: string,
) => record?.drawingSources?.find((p) => p.contentHash === contentHash);

/** A version save's record keeps every version either side holds. */
export function mergeDrawingSources(
  saved: Pick<StoredArtifact, 'drawingSources' | 'drawingAssets' | 'drawingIssues'>,
  latest: Pick<StoredArtifact, 'drawingSources' | 'drawingAssets' | 'drawingIssues'>,
): Pick<StoredArtifact, 'drawingSources' | 'drawingAssets' | 'drawingIssues'> {
  const out: Pick<StoredArtifact, 'drawingSources' | 'drawingAssets' | 'drawingIssues'> = {};
  // DW6b: an issue kept on either side stays (each names its own version).
  if (saved.drawingIssues || latest.drawingIssues) {
    const merged = [...(latest.drawingIssues ?? [])];
    for (const i of saved.drawingIssues ?? [])
      if (!merged.some((m) => m.versionId === i.versionId)) merged.push(i);
    out.drawingIssues = merged;
  }
  if (saved.drawingSources || latest.drawingSources) {
    const merged = [...(latest.drawingSources ?? [])];
    for (const p of saved.drawingSources ?? [])
      if (!merged.some((m) => m.contentHash === p.contentHash)) merged.push(p);
    out.drawingSources = merged;
  }
  if (saved.drawingAssets || latest.drawingAssets) {
    const merged = [...(latest.drawingAssets ?? [])];
    for (const a of saved.drawingAssets ?? [])
      if (!merged.some((m) => m.kind === a.kind && m.sha256 === a.sha256)) merged.push(a);
    out.drawingAssets = merged;
  }
  return out;
}

/** DW3c-2: the bytes of a kept asset, for the kernel's evaluation of imported geometry. */
export function drawingAssetBytes(
  record: Pick<StoredArtifact, 'drawingAssets'> | undefined,
  sha: string,
): Uint8Array | undefined {
  const r = record?.drawingAssets?.find((a) => a.sha256 === sha);
  return r ? decodeBytes(r.bytes) : undefined;
}

/** DW6b: issues a drawing keeps, at most, and an issued PDF's bytes, at most. */
export const drawingIssueLimits = Object.freeze({ issues: 200, pdfBytes: 32 * 1024 * 1024 });

/** DW6b: an issue's record: its version, sheets and PDF bytes (hashed). */
export function drawingIssueRecord(
  versionId: string,
  issuedAt: string,
  sheets: DrawingIssueRecord['sheets'],
  pdf: Uint8Array,
): DrawingIssueRecord {
  return {
    versionId,
    issuedAt,
    sheets: sheets.map((s) => ({ sheetId: s.sheetId, name: s.name, mark: s.mark })),
    pdf: {
      sha256: `sha256:${bytesToHex(sha256(pdf))}`,
      byteLength: pdf.length,
      mediaType: 'application/pdf',
      encoding: 'base64',
      bytes: encodeBytes(pdf),
    },
  };
}

/** DW6b: an issued PDF's bytes, checked. */
export function drawingIssuePdf(
  record: Pick<StoredArtifact, 'drawingIssues'> | undefined,
  versionId: string,
): Uint8Array | undefined {
  const i = record?.drawingIssues?.find((x) => x.versionId === versionId);
  return i ? decodeBytes(i.pdf.bytes) : undefined;
}

/**
 * DW6b: each issue names a saved version of the record, once; its sheets are that version's
 * and carry their marks in its revision tables; its PDF is the bytes its hash names.
 */
function validateDrawingIssues(record: Pick<StoredArtifact, 'versions' | 'drawingIssues'>) {
  const issues = record.drawingIssues;
  if (issues === undefined) return;
  if (!Array.isArray(issues) || issues.length > drawingIssueLimits.issues)
    throw new Error('Drawing issues');
  const seen = new Set<string>();
  for (const i of issues as unknown[]) {
    const r = i as DrawingIssueRecord;
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).sort().join() !== 'issuedAt,pdf,sheets,versionId' ||
      typeof r.versionId !== 'string' ||
      typeof r.issuedAt !== 'string' ||
      !Array.isArray(r.sheets) ||
      !r.sheets.length ||
      !r.pdf ||
      typeof r.pdf !== 'object' ||
      Object.keys(r.pdf).sort().join() !== 'byteLength,bytes,encoding,mediaType,sha256' ||
      r.pdf.mediaType !== 'application/pdf' ||
      r.pdf.encoding !== 'base64' ||
      r.pdf.byteLength > drawingIssueLimits.pdfBytes
    )
      throw new Error('Drawing issue');
    if (seen.has(r.versionId)) throw new Error('Drawing issue duplicated');
    seen.add(r.versionId);
    const version = record.versions.find((v) => v.versionId === r.versionId);
    if (!version) throw new Error('Drawing issue version missing');
    const doc = version.content as DrawingDocument;
    for (const s of r.sheets as unknown[]) {
      const x = s as DrawingIssueRecord['sheets'][number];
      if (
        !x ||
        typeof x !== 'object' ||
        Object.keys(x).sort().join() !== 'mark,name,sheetId' ||
        typeof x.name !== 'string' ||
        !doc.sheets?.find((d) => d.id === x.sheetId)?.revisions.some((v) => v.mark === x.mark)
      )
        throw new Error('Drawing issue sheet');
    }
    const bytes = decodeBytes(r.pdf.bytes);
    if (bytes.length !== r.pdf.byteLength || `sha256:${bytesToHex(sha256(bytes))}` !== r.pdf.sha256)
      throw new Error('Drawing issue hash mismatch');
  }
}
