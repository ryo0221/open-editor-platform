import { canonicalJson } from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type {
  DrawingAnnotation,
  DrawingDocument,
  DrawingRevision,
  DrawingSheet,
  DrawingSheetSize,
  DrawingOrientation,
  DrawingRef,
  DrawingSource,
  DrawingTitleBlock,
  DrawingView,
  Vec2,
} from './model';
import { validateDrawing } from './validation';

/**
 * Pure edits of drawing content (DW1). Each returns a new document that is validated as a whole;
 * any problem throws `DrawingEditError` and leaves the input untouched. The caller's trusted layer
 * assigns every new ID.
 */
export class DrawingEditError extends Error {
  constructor(
    readonly code: string,
    readonly path?: string,
  ) {
    super(path ? `${code}@${path}` : code);
  }
}

export const drawingContentHash = (doc: DrawingDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

const checked = (doc: DrawingDocument): DrawingDocument => {
  const d = validateDrawing(doc)[0];
  if (d) throw new DrawingEditError(d.code, d.path);
  return doc;
};
const edit = (doc: DrawingDocument, change: (d: DrawingDocument) => void) => {
  const next = structuredClone(doc);
  change(next);
  return checked(next);
};

export const emptyTitleBlock = (title = ''): DrawingTitleBlock => ({
  title,
  drawingNumber: '',
  organization: '',
  project: '',
  material: '',
  quantity: '',
  drawnBy: '',
  checkedBy: '',
  approvedBy: '',
  date: '',
});

export function newDrawingSheet(
  id: string,
  name: string,
  size: DrawingSheetSize = 'A3',
  orientation: DrawingOrientation = 'landscape',
): DrawingSheet {
  return {
    id,
    name,
    size,
    orientation,
    filing: false,
    title: emptyTitleBlock(name),
    revisions: [],
  };
}

/** A new drawing: one empty A3 landscape sheet, third-angle projection. */
export function drawingStarter(name = 'Drawing'): DrawingDocument {
  return checked({
    schemaVersion: 1,
    name,
    projection: 'third-angle',
    sources: [],
    sheets: [newDrawingSheet('sheet-1', 'Sheet 1')],
    views: [],
    annotations: [],
  });
}

export const addDrawingSheet = (doc: DrawingDocument, sheet: DrawingSheet) =>
  edit(doc, (d) => void d.sheets.push(structuredClone(sheet)));

/** Replaces one sheet (its size, orientation, title block or revisions) by ID. */
export function updateDrawingSheet(doc: DrawingDocument, sheet: DrawingSheet) {
  const i = doc.sheets.findIndex((s) => s.id === sheet.id);
  if (i < 0) throw new DrawingEditError('sheet-missing');
  return edit(doc, (d) => void (d.sheets[i] = structuredClone(sheet)));
}

/** Adds a revision at the end of a sheet's table (the newest). */
export function addDrawingRevision(
  doc: DrawingDocument,
  sheetId: string,
  revision: DrawingRevision,
) {
  const sheet = doc.sheets.find((s) => s.id === sheetId);
  if (!sheet) throw new DrawingEditError('sheet-missing');
  return updateDrawingSheet(doc, { ...sheet, revisions: [...sheet.revisions, revision] });
}

/**
 * The next revision mark after a sheet's last one: `A` → `B`, `Z` → `AA`, `AZ` → `BA`, `9` → `10`,
 * `B2` → `B3`; `A` on a new sheet. A mark grows only as its count does, so a sheet's whole revision
 * allowance stays within the mark's length (Codex on #1278).
 */
export function nextRevisionMark(sheet: Pick<DrawingSheet, 'revisions'>): string {
  const last = sheet.revisions.at(-1)?.mark;
  if (!last) return 'A';
  const digits = /^(.*?)(\d+)$/.exec(last);
  if (digits) return `${digits[1]}${Number(digits[2]) + 1}`;
  if (/^[A-Z]+$/.test(last)) {
    const letters = [...last];
    let i = letters.length - 1;
    while (i >= 0 && letters[i] === 'Z') letters[i--] = 'A';
    if (i < 0) return `A${letters.join('')}`;
    letters[i] = String.fromCharCode(letters[i]!.charCodeAt(0) + 1);
    return letters.join('');
  }
  return `${last}1`;
}

/**
 * The source for an exact version: the one already in the document (same Artifact, version and
 * hash), or `source` added. Returns the document and the source's ID.
 */
export function useDrawingSource(
  doc: DrawingDocument,
  source: DrawingSource,
): { doc: DrawingDocument; sourceId: string } {
  const existing = doc.sources.find(
    (s) =>
      s.kind === source.kind &&
      s.artifactId === source.artifactId &&
      s.versionId === source.versionId &&
      s.contentHash === source.contentHash,
  );
  if (existing) return { doc, sourceId: existing.id };
  return {
    doc: edit(doc, (d) => void d.sources.push(structuredClone(source))),
    sourceId: source.id,
  };
}

export const addDrawingView = (doc: DrawingDocument, view: DrawingView) =>
  edit(doc, (d) => void d.views.push(structuredClone(view)));

/** Replaces one view by ID. */
export function updateDrawingView(doc: DrawingDocument, view: DrawingView) {
  const i = doc.views.findIndex((v) => v.id === view.id);
  if (i < 0) throw new DrawingEditError('view-missing');
  return edit(doc, (d) => void (d.views[i] = structuredClone(view)));
}

export const addDrawingAnnotation = (doc: DrawingDocument, annotation: DrawingAnnotation) =>
  edit(doc, (d) => void d.annotations.push(structuredClone(annotation)));

/** Adds several annotations as one edit (DW3c-2b: a view's PMI imported at once). */
export const addDrawingAnnotations = (doc: DrawingDocument, list: readonly DrawingAnnotation[]) => {
  if (!list.length) throw new DrawingEditError('selection-empty');
  return edit(doc, (d) => void d.annotations.push(...structuredClone(list)));
};

export function updateDrawingAnnotation(doc: DrawingDocument, annotation: DrawingAnnotation) {
  const i = doc.annotations.findIndex((a) => a.id === annotation.id);
  if (i < 0) throw new DrawingEditError('annotation-missing');
  return edit(doc, (d) => void (d.annotations[i] = structuredClone(annotation)));
}

/**
 * DW3c: puts another edge under one ref of a dimension (`index`), leader or symbol (0): a
 * candidate of an ambiguous ref, or an edge picked again for an unresolved one.
 */
export function rebindDrawingRef(
  doc: DrawingDocument,
  annotationId: string,
  index: number,
  ref: DrawingRef,
) {
  const i = doc.annotations.findIndex((a) => a.id === annotationId);
  const a = doc.annotations[i];
  if (!a) throw new DrawingEditError('annotation-missing');
  if (
    a.kind === 'note' ||
    a.kind === 'pmi' ||
    a.kind === 'parts-list' ||
    ((a.kind === 'leader' || a.kind === 'symbol') && !a.ref)
  )
    throw new DrawingEditError('ref-missing');
  const refs = a.kind === 'dimension' ? a.refs : [a.ref!];
  if (!Number.isInteger(index) || index < 0 || index >= refs.length)
    throw new DrawingEditError('ref-missing');
  return edit(doc, (d) => {
    const x = d.annotations[i]!;
    if (x.kind === 'dimension') x.refs[index] = structuredClone(ref);
    else if (x.kind === 'leader' || x.kind === 'symbol' || x.kind === 'balloon')
      x.ref = structuredClone(ref);
  });
}

/** Moves views and notes by `delta` on the paper, as one edit (dragging a selection). */
export function moveDrawingItems(doc: DrawingDocument, ids: readonly string[], delta: Vec2) {
  const set = new Set(ids);
  if (!set.size) throw new DrawingEditError('selection-empty');
  for (const i of set)
    if (!doc.views.some((v) => v.id === i) && !doc.annotations.some((a) => a.id === i))
      throw new DrawingEditError('item-missing');
  return edit(doc, (d) => {
    for (const o of [...d.views, ...d.annotations]) {
      // A dimension or leader sits relative to its view: moving both moves it once.
      // (A parts list sits on the paper, not relative to its view.)
      if ('viewId' in o && o.viewId && set.has(o.viewId) && o.kind !== 'parts-list') continue;
      if (set.has(o.id)) o.at = [o.at[0] + delta[0], o.at[1] + delta[1]];
    }
  });
}

/**
 * Deletes views, notes and sheets by ID. A deleted sheet takes its views and notes with it;
 * a source no view sees any more is dropped.
 */
export function deleteDrawingItems(doc: DrawingDocument, ids: readonly string[]) {
  const set = new Set(ids);
  if (!set.size) throw new DrawingEditError('selection-empty');
  for (const i of set)
    if (
      !doc.views.some((v) => v.id === i) &&
      !doc.annotations.some((a) => a.id === i) &&
      !doc.sheets.some((s) => s.id === i)
    )
      throw new DrawingEditError('item-missing');
  if (doc.sheets.every((s) => set.has(s.id))) throw new DrawingEditError('sheet-last');
  // A view takes its sections and details (and theirs) with it, on whatever sheet they are.
  const gone = new Set(
    doc.views.filter((v) => set.has(v.id) || set.has(v.sheetId)).map((v) => v.id),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of doc.views)
      if (
        (v.kind === 'cad-section' || v.kind === 'cad-detail') &&
        !gone.has(v.id) &&
        gone.has(v.parentId)
      ) {
        gone.add(v.id);
        grew = true;
      }
  }
  return edit(doc, (d) => {
    d.sheets = d.sheets.filter((s) => !set.has(s.id));
    d.views = d.views.filter((v) => !gone.has(v.id));
    // Dimensions and leaders in a deleted view go with it.
    d.annotations = d.annotations.filter(
      (a) => !set.has(a.id) && !set.has(a.sheetId) && !(a.kind !== 'note' && gone.has(a.viewId)),
    );
    const seen = new Set(d.views.map((v) => v.sourceId));
    d.sources = d.sources.filter((s) => seen.has(s.id));
  });
}

/** The first datum letter (A, B, … without I, O and Q) no datum of the drawing has (DW3b). */
export function nextDrawingDatum(doc: DrawingDocument): string {
  const used = new Set(
    doc.annotations.flatMap((a) =>
      a.kind === 'symbol' && a.symbol.type === 'datum' ? [a.symbol.letter] : [],
    ),
  );
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (const a of ['', ...letters]) for (const b of letters) if (!used.has(a + b)) return a + b;
  throw new DrawingEditError('limit-marks');
}

/** The first mark (`A`, `B`, … `Z`, then `AA`, …) no section or detail of the drawing has. */
export function nextDrawingMark(doc: DrawingDocument): string {
  const used = new Set(
    doc.views.map((v) => (v.kind === 'cad-section' || v.kind === 'cad-detail' ? v.mark : '')),
  );
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (const a of ['', ...letters]) for (const b of letters) if (!used.has(a + b)) return a + b;
  throw new DrawingEditError('limit-marks');
}

/**
 * Points every view of a source at another version of the same Artifact (新しい版, DW2b), as one
 * edit: the source keeps its ID (or, when the drawing already sees that version, its views move
 * to that source and the old one is dropped).
 */
export function switchDrawingSource(
  doc: DrawingDocument,
  sourceId: string,
  to: Pick<DrawingSource, 'versionId' | 'contentHash' | 'name'>,
) {
  const from = doc.sources.find((s) => s.id === sourceId);
  if (!from) throw new DrawingEditError('source-missing');
  if (from.versionId === to.versionId && from.contentHash === to.contentHash)
    throw new DrawingEditError('source-same');
  const twin = doc.sources.find(
    (s) =>
      s.id !== sourceId &&
      s.kind === from.kind &&
      s.artifactId === from.artifactId &&
      s.versionId === to.versionId &&
      s.contentHash === to.contentHash,
  );
  return edit(doc, (d) => {
    if (twin) {
      for (const v of d.views) if (v.sourceId === sourceId) v.sourceId = twin.id;
      d.sources = d.sources.filter((s) => s.id !== sourceId);
      return;
    }
    const s = d.sources.find((x) => x.id === sourceId)!;
    s.versionId = to.versionId;
    s.contentHash = to.contentHash;
    s.name = to.name;
  });
}

/** A fresh ID with `prefix` that no entity of the document has. */
export function freshDrawingId(doc: DrawingDocument, prefix: string): string {
  const used = new Set<string>([
    ...doc.sources.map((s) => s.id),
    ...doc.sheets.flatMap((s) => [s.id, ...s.revisions.map((r) => r.id)]),
    ...doc.views.map((v) => v.id),
    ...doc.annotations.map((a) => a.id),
  ]);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export interface DrawingCommandOptions {
  /** contentHash of the base the edit was prepared against; `apply` throws on any other base. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}

/** One ordinary EditorSession transaction replacing the document; re-checks base and authority. */
export function drawingEditorCommand(
  label: string,
  next: DrawingDocument,
  options: DrawingCommandOptions,
): EditorCommand<DrawingDocument> {
  const prepared = checked(structuredClone(next));
  const run = (content: DrawingDocument) => {
    if (!options.canEdit()) throw new DrawingEditError('permission-denied');
    if (drawingContentHash(content) !== options.expectedHash)
      throw new DrawingEditError('drawing-base-mismatch');
    return structuredClone(prepared);
  };
  const cmd = options.context
    ? immutableCommand('drawing.edit', label, run, options.context)
    : immutableCommand('drawing.edit', label, run);
  return withCommandReads(cmd, { content: ['*'] });
}
