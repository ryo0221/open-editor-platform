import {
  addDrawingAnnotation,
  nextDrawingDatum,
  addDrawingRevision,
  addDrawingSheet,
  addDrawingView,
  deleteDrawingItems,
  drawingFitScale,
  drawingProjectedSize,
  drawingSheetLayout,
  drawingThreeViewLayout,
  useDrawingSource,
  drawingContentHash,
  drawingEditorCommand,
  DrawingEditError,
  drawingSheetPaper,
  drawingSheetSvg,
  drawingIssueBlockers,
  drawingSheetPrint,
  drawingDxf,
  type DrawingPaperSheet,
  freshDrawingId,
  moveDrawingItems,
  newDrawingSheet,
  nextDrawingMark,
  nextRevisionMark,
  drawingBimScales,
  drawingScales,
  drawingScaleFactor,
  switchDrawingSource,
  type DrawingCadDetail,
  type DrawingCadSection,
  updateDrawingAnnotation,
  updateDrawingSheet,
  updateDrawingView,
  validateDrawing,
  drawingAnnotationGraphics,
  drawingAnchorIssues,
  drawingSnap,
  rebindDrawingRef,
  addDrawingAnnotations,
  drawingPmiResolve,
  drawingPaperOf,
  drawingPmiSymbol,
  drawingPmiText,
  drawingPartRowOf,
  drawingBalloonRadius,
  drawingCandidateDimensions,
  drawingIsAssembly,
  drawingLimits,
  drawingHoleCircles,
  type DrawingBalloon,
  type DrawingPartsList,
  type DrawingPmiLive,
  type DrawingPmiNote,
  type DrawingAnnotation,
  type DrawingCadView,
  type DrawingDimension,
  type DrawingDimensionType,
  type DrawingLeader,
  type DrawingRef,
  type DrawingSnap,
  type DrawingSymbol,
  type DrawingSymbolSpec,
  type DrawingSnapKind,
  type DrawingDirection,
  type DrawingDocument,
  type DrawingNote,
  type DrawingScale,
  type DrawingBimScale,
  type DrawingBuildingView,
  type DrawingElevationSide,
  type DrawingSource,
  type DrawingOrientation,
  type DrawingSheet,
  type DrawingSheetSize,
  type DrawingTextHeight,
  type DrawingView,
  type DrawingViewState,
  type Vec2,
  drawingIsBuildingView,
} from '@editor-platform/drawing-core';
import { DrawingPdfError, drawingPdf } from './pdf';
import type { EditorSession } from '@editor-platform/editor-core';

/**
 * The drawing Surface's state without React (docs/cad/drawing-editor.md, DW1). Every edit is one
 * session command that replaces the document; the Host saves afterwards and owns Undo/Redo. The
 * views' derived graphics (DW2, DW5) come from `derive` and are kept here, never in the content.
 */
export type DrawingSession = Pick<EditorSession<DrawingDocument>, 'content' | 'execute'>;

export interface DrawingNotice {
  code: string;
  path?: string;
}

export interface DrawingSurfaceState {
  content: DrawingDocument;
  hash: string;
  readOnly: boolean;
  /** The sheet on screen. */
  sheetId: string;
  /** Selected views and notes on that sheet. */
  selection: string[];
  /** Each view's derived graphics, pending state or failure, by view ID. */
  views: ReadonlyMap<string, DrawingViewState>;
  notice?: DrawingNotice;
  /**
   * A building view being drawn before it is placed (it goes on the sheet once its size is
   * known): the sheet shows where it is being drawn and at what scale, so a long drawing is never
   * a blank sheet.
   */
  placing?: readonly DrawingPlacing[];
}

/** A building view being drawn before it is placed (`DrawingSurfaceState.placing`). */
export interface DrawingPlacing {
  sheetId: string;
  name: string;
  /** The scale being drawn (`fit` before the first). */
  scale: string;
  /** Where on the paper it is drawn (mm). */
  at: Vec2;
}

export interface DrawingControllerOptions {
  session: DrawingSession;
  /** Trusted, current edit authority; re-read by every command. */
  canEdit(): boolean;
  /** After an edit is applied: the Host saves the draft. */
  onApplied?(content: DrawingDocument): void;
  /**
   * What a view shows (DW2, DW5). Without it a view stays a placeholder that says it is not
   * derived. A key that does not change keeps the graphics already derived.
   */
  /** The CAD versions views can be made of, from the Host (DW2). */
  sources?: DrawingSources;
  derive?: {
    key(doc: DrawingDocument, view: DrawingView): string;
    run(doc: DrawingDocument, view: DrawingView, signal: AbortSignal): Promise<DrawingViewState>;
  };
  /**
   * DW6: the fixed font PDF text is drawn in (OpenType bytes, checked by the Host). Without it
   * PDF export is refused (`pdf-font-unavailable`).
   */
  pdfFont?(): Promise<Uint8Array>;
  /** DW6b: issuing sheets, kept by the Host with a saved version. Without it: refused. */
  issues?: DrawingIssueHost;
}

/** DW6b: one issue (発行) of sheets, as the Host keeps it. */
export interface DrawingIssueInfo {
  /** The saved version the issue made. */
  versionId: string;
  issuedAt: string;
  sheets: { sheetId: string; name: string; mark: string }[];
  byteLength: number;
}
export interface DrawingIssueHost {
  /** Issues so far, oldest first. */
  list(): DrawingIssueInfo[];
  /** An issue's PDF, as it was issued. */
  pdf(versionId: string): Uint8Array | undefined;
  /**
   * Saves `content` (the drawing with its new revisions) as an immutable version and keeps the
   * PDF with it. Returns why not, or nothing.
   */
  issue(request: {
    content: DrawingDocument;
    pdf: Uint8Array;
    sheets: DrawingIssueInfo['sheets'];
    reason: string;
  }): Promise<string | undefined>;
}

/** One of a building version's own drawing views (DW5a). */
export interface DrawingBimViewChoice {
  id: string;
  name: string;
  kind: 'plan' | 'section';
  /** The scale the building editor draws it at. */
  scale: DrawingBimScale;
}
/** DW5b: what a building view shows (its kind and own fields). */
export type DrawingBuildingViewWhat =
  | { kind: 'bim-view'; bimViewId: string }
  | { kind: 'bim-elevation'; side: DrawingElevationSide }
  | { kind: 'bim-framing'; levelId: string }
  | { kind: 'bim-frame'; gridId: string; bandMm: number };
/**
 * A building view's name from the building's (up to 255 code points against the drawing's 200):
 * its head cut to leave room for the kind it names (Codex on #1238).
 */
const viewName = (head: string, tail = '') =>
  [...head.replace(/\p{Cc}/gu, ' ')]
    .slice(0, drawingLimits.textCodePoints - [...tail].length)
    .join('') + tail;
const elevationNames: Record<DrawingElevationSide, string> = {
  front: '正面立面図',
  rear: '背面立面図',
  left: '左側立面図',
  right: '右側立面図',
};

/** A saved CAD or building version the drawing may show (the Host lists them; DW2, DW5a). */
export interface DrawingSourceChoice {
  key: string;
  kind: 'cad' | 'bim';
  /** A building version's plans and sections. */
  views?: DrawingBimViewChoice[];
  /** DW5b: a building version's levels (framing plans) and grid axes (framing elevations). */
  levels?: { id: string; name: string }[];
  grids?: { id: string; label: string }[];
  artifactId: string;
  versionId: string;
  contentHash: string;
  name: string;
  /** How the picker shows it (`Gear train · v3`). */
  label: string;
}
export interface DrawingSources {
  choices(): DrawingSourceChoice[];
  /**
   * Keeps the version with the drawing (before any edit names it) and returns its model box
   * (mm), its nested parts included, or a refusal code. A building version has no box: its views
   * are drawn whole (DW5a).
   */
  prepare(
    choice: DrawingSourceChoice,
    /** DW4b: the box of only these bodies (a view's `only`); none for the whole version. */
    only?: readonly string[],
  ): Promise<{ box?: [[number, number, number], [number, number, number]] } | { code: string }>;
}
/** A round radius near `r` (1, 2 or 5 times a power of ten), for a new detail. */
function niceRadius(r: number): number {
  if (!(r > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(r));
  return [1, 2, 5, 10]
    .map((k) => k * p)
    .reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a));
}

/** Which way a section's arrows point on its parent's paper (the way it is seen). */
export type DrawingSectionLook = 'left' | 'right' | 'up' | 'down';

/** The views `addCadViews` places: a third-angle (or first-angle) set of three, or one. */
export type DrawingViewSet = 'three' | DrawingDirection;

const viewNames: Record<DrawingDirection, string> = {
  front: '正面図',
  top: '平面図',
  right: '右側面図',
  left: '左側面図',
  bottom: '下面図',
  rear: '背面図',
  iso: '等角図',
};

const checkedPatch = (doc: DrawingDocument, patch: Partial<DrawingDocument>) => {
  const next = { ...structuredClone(doc), ...patch };
  const d = validateDrawing(next)[0];
  if (d) throw new DrawingEditError(d.code, d.path);
  return next;
};
const checkedRename = (doc: DrawingDocument, name: string) => checkedPatch(doc, { name });

export class DrawingController {
  /** An issue is being saved by the Host: revisions and sheet deletion wait (Codex on #1246). */
  private issueSaving = false;
  private current: DrawingSurfaceState;
  private readonly listeners = new Set<() => void>();
  private readonly derived = new Map<string, { key: string; state: DrawingViewState }>();
  private readonly running = new Map<string, { key: string; abort: AbortController }>();

  constructor(private readonly options: DrawingControllerOptions) {
    const content = options.session.content;
    this.current = {
      content,
      hash: drawingContentHash(content),
      readOnly: !options.canEdit(),
      sheetId: content.sheets[0]!.id,
      selection: [],
      views: new Map(),
    };
    this.refreshViews();
  }

  /** The CAD versions the Host offers for new views, if it offers any. */
  get sources(): DrawingSources | undefined {
    return this.options.sources;
  }
  get state(): DrawingSurfaceState {
    return this.current;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private set(patch: Partial<DrawingSurfaceState>) {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }
  private refuse(notice: DrawingNotice) {
    this.set({ notice });
    return notice.code;
  }
  dismissNotice() {
    this.set({ notice: undefined });
  }
  accessChanged() {
    this.set({ readOnly: !this.options.canEdit() });
  }
  /** Host Undo/Redo or restore changed the session's content: show it. */
  sync() {
    const content = this.options.session.content;
    this.adopt(content);
  }
  dispose() {
    for (const r of this.running.values()) r.abort.abort();
    this.running.clear();
  }

  private adopt(content: DrawingDocument) {
    const sheetId = content.sheets.some((s) => s.id === this.current.sheetId)
      ? this.current.sheetId
      : content.sheets[0]!.id;
    const exists = new Set([
      ...content.views.map((v) => v.id),
      ...content.annotations.map((a) => a.id),
    ]);
    this.set({
      content,
      hash: drawingContentHash(content),
      sheetId,
      selection: this.current.selection.filter((id) => exists.has(id)),
    });
    this.refreshViews();
  }

  /** Starts deriving every view whose key changed; drops the graphics of views that are gone. */
  private refreshViews() {
    const doc = this.current.content;
    const derive = this.options.derive;
    const views = new Map<string, DrawingViewState>();
    const live = new Set(doc.views.map((v) => v.id));
    for (const id of [...this.derived.keys()]) if (!live.has(id)) this.derived.delete(id);
    for (const [id, r] of [...this.running])
      if (!live.has(id)) {
        r.abort.abort();
        this.running.delete(id);
      }
    for (const v of doc.views) {
      if (!derive) {
        views.set(v.id, { status: 'failed', code: 'not-derived' });
        continue;
      }
      const key = derive.key(doc, v);
      const have = this.derived.get(v.id);
      if (have?.key === key) {
        // A derivation started for another key (an edit since undone) must not replace these.
        const stale = this.running.get(v.id);
        if (stale && stale.key !== key) {
          stale.abort.abort();
          this.running.delete(v.id);
        }
        views.set(v.id, have.state);
        continue;
      }
      // Keep the old graphics on screen while the new ones are derived only if they are ready.
      views.set(v.id, { status: 'pending' });
      if (this.running.get(v.id)?.key === key) continue;
      this.running.get(v.id)?.abort.abort();
      const abort = new AbortController();
      this.running.set(v.id, { key, abort });
      void derive
        .run(doc, v, abort.signal)
        .catch(
          (e: unknown): DrawingViewState => ({
            status: 'failed',
            code: e instanceof Error && e.message ? e.message : 'derive-failed',
          }),
        )
        .then((state) => {
          if (abort.signal.aborted || this.running.get(v.id)?.abort !== abort) return;
          this.running.delete(v.id);
          this.derived.set(v.id, { key, state });
          const next = new Map(this.current.views);
          next.set(v.id, state);
          this.set({ views: next });
        });
    }
    this.set({ views });
  }

  // Editing.

  private edit(label: string, make: (doc: DrawingDocument) => DrawingDocument): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    let next: DrawingDocument;
    try {
      next = make(this.current.content);
    } catch (e) {
      if (e instanceof DrawingEditError) return this.refuse({ code: e.code, path: e.path });
      throw e;
    }
    let content: DrawingDocument;
    try {
      content = this.options.session.execute(
        drawingEditorCommand(label, next, {
          expectedHash: this.current.hash,
          canEdit: () => this.options.canEdit(),
        }),
      );
    } catch (e) {
      if (e instanceof DrawingEditError) return this.refuse({ code: e.code, path: e.path });
      throw e;
    }
    this.adopt(content);
    this.set({ notice: undefined });
    this.options.onApplied?.(content);
    return undefined;
  }

  get sheet(): DrawingSheet {
    return this.current.content.sheets.find((s) => s.id === this.current.sheetId)!;
  }
  showSheet(sheetId: string) {
    if (!this.current.content.sheets.some((s) => s.id === sheetId)) return;
    this.set({ sheetId, selection: [] });
  }
  select(ids: string[]) {
    this.set({ selection: ids });
  }

  setName(name: string) {
    return this.edit('Rename drawing', (d) => checkedRename(d, name));
  }
  setProjection(projection: DrawingDocument['projection']) {
    return this.edit('Edit projection', (d) => checkedPatch(d, { projection }));
  }
  addSheet(size: DrawingSheetSize, orientation: DrawingOrientation) {
    const doc = this.current.content;
    const id = freshDrawingId(doc, 'sheet');
    const sheet = newDrawingSheet(id, `Sheet ${doc.sheets.length + 1}`, size, orientation);
    const err = this.edit('Add sheet', (d) => addDrawingSheet(d, sheet));
    if (!err) this.set({ sheetId: id, selection: [] });
    return err;
  }
  /** Changes the sheet on screen (name, size, orientation, filing margin, title block). */
  updateSheet(patch: Partial<Omit<DrawingSheet, 'id' | 'revisions'>>, label = 'Edit sheet') {
    return this.edit(label, (d) => updateDrawingSheet(d, { ...this.sheet, ...patch }));
  }
  /** Issues the next revision of the sheet on screen (改訂). */
  addRevision(description: string, date: string, by: string) {
    // An issue being saved holds the next marks of its sheets (Codex on #1246).
    if (this.issueSaving) return this.refuse({ code: 'issue-busy' });
    return this.edit('Add revision', (d) =>
      addDrawingRevision(d, this.sheet.id, {
        id: freshDrawingId(d, 'rev'),
        mark: nextRevisionMark(this.sheet),
        date,
        description,
        by,
      }),
    );
  }
  addNote(at: Vec2, text: string, heightMm: DrawingTextHeight = 3.5) {
    const doc = this.current.content;
    const id = freshDrawingId(doc, 'note');
    const note: DrawingNote = { id, sheetId: this.sheet.id, kind: 'note', at, text, heightMm };
    const err = this.edit('Add note', (d) => addDrawingAnnotation(d, note));
    if (!err) this.set({ selection: [id] });
    return err;
  }
  updateNote(note: DrawingNote) {
    return this.edit('Edit note', (d) => updateDrawingAnnotation(d, note));
  }
  /** Changes a dimension or a leader (its text, tolerance, place). */
  updateAnnotation(a: DrawingAnnotation, label = 'Edit dimension') {
    return this.edit(label, (d) => updateDrawingAnnotation(d, a));
  }

  /** The nearest snap (DW3) on the sheet on screen within `tolerance` paper mm of `p`. */
  snap(p: Vec2, kind: DrawingSnapKind, tolerance: number): DrawingSnap | undefined {
    return drawingSnap(this.current.content, this.current.views, this.sheet.id, p, kind, tolerance);
  }

  /**
   * Adds a dimension (DW3) of refs in one view, its line (or text) through `paper` on the sheet.
   * The value is measured on the 3D shape when it is drawn.
   */
  addDimension(
    viewId: string,
    type: DrawingDimensionType,
    refs: DrawingRef[],
    paper: Vec2,
    select = true,
  ) {
    const doc = this.current.content;
    const view = doc.views.find((v) => v.id === viewId);
    if (!view) return this.refuse({ code: 'view-missing' });
    const id = freshDrawingId(doc, 'dim');
    const dim: DrawingDimension = {
      id,
      sheetId: view.sheetId,
      kind: 'dimension',
      viewId,
      type,
      refs,
      at: [paper[0] - view.at[0], paper[1] - view.at[1]],
      text: '',
      tolerance: '',
      heightMm: 3.5,
    };
    const err = this.edit('Add dimension', (d) => addDrawingAnnotation(d, dim));
    if (!err && select) this.set({ selection: [id] });
    return err;
  }

  /** Adds a leader note (DW3) pointing at a ref of a view, or at a place on the sheet. */
  addLeader(target: { viewId: string; ref: DrawingRef } | Vec2, paper: Vec2, text = '注記') {
    const doc = this.current.content;
    const id = freshDrawingId(doc, 'leader');
    let leader: DrawingLeader;
    if (Array.isArray(target))
      leader = {
        id,
        sheetId: this.sheet.id,
        kind: 'leader',
        viewId: '',
        ref: null,
        target,
        at: paper,
        text,
        heightMm: 3.5,
      };
    else {
      const view = doc.views.find((v) => v.id === target.viewId);
      if (!view) return this.refuse({ code: 'view-missing' });
      leader = {
        id,
        sheetId: view.sheetId,
        kind: 'leader',
        viewId: view.id,
        ref: target.ref,
        target: [0, 0],
        at: [paper[0] - view.at[0], paper[1] - view.at[1]],
        text,
        heightMm: 3.5,
      };
    }
    const err = this.edit('Add leader', (d) => addDrawingAnnotation(d, leader));
    if (!err) this.set({ selection: [id] });
    return err;
  }

  /**
   * Adds a drawing symbol (DW3b: tolerance frame, datum, surface texture, weld) pointing at a
   * ref of a view or a place on the sheet. A datum takes the next free letter.
   */
  addSymbol(
    target: { viewId: string; ref: DrawingRef } | Vec2,
    paper: Vec2,
    spec: DrawingSymbolSpec,
  ) {
    const doc = this.current.content;
    const id = freshDrawingId(doc, 'sym');
    const symbol =
      spec.type === 'datum' ? { ...spec, letter: spec.letter || nextDrawingDatum(doc) } : spec;
    let sym: DrawingSymbol;
    if (Array.isArray(target))
      sym = {
        id,
        sheetId: this.sheet.id,
        kind: 'symbol',
        viewId: '',
        ref: null,
        target,
        at: paper,
        symbol,
        heightMm: 3.5,
      };
    else {
      const view = doc.views.find((v) => v.id === target.viewId);
      if (!view) return this.refuse({ code: 'view-missing' });
      sym = {
        id,
        sheetId: view.sheetId,
        kind: 'symbol',
        viewId: view.id,
        ref: target.ref,
        target: [0, 0],
        at: [paper[0] - view.at[0], paper[1] - view.at[1]],
        symbol,
        heightMm: 3.5,
      };
    }
    const err = this.edit('Add symbol', (d) => addDrawingAnnotation(d, sym));
    if (!err) this.set({ selection: [id] });
    return err;
  }

  /** DW4: the parts (flat BOM) of the version a view shows, once it has derived. */
  partsOf(viewId: string) {
    const st = this.current.views.get(viewId);
    return st?.status === 'ready' ? st.graphics.parts : undefined;
  }

  /** DW4: the parts-list row a ref's body counts in, in a view. */
  partRowOf(viewId: string, ref: Pick<DrawingRef, 'path' | 'bodyId'>) {
    return drawingPartRowOf(this.partsOf(viewId), ref);
  }

  /** DW4: a balloon on a picked edge of a part in a view, its circle at `paper`. */
  addBalloon(viewId: string, ref: DrawingRef, paper: Vec2) {
    const doc = this.current.content;
    const view = doc.views.find((v) => v.id === viewId);
    if (!view) return this.refuse({ code: 'view-missing' });
    if (!drawingPartRowOf(this.partsOf(viewId), ref)) return this.refuse({ code: 'part-none' });
    const balloon: DrawingBalloon = {
      id: freshDrawingId(doc, 'balloon'),
      sheetId: view.sheetId,
      kind: 'balloon',
      viewId,
      ref: structuredClone(ref),
      at: [paper[0] - view.at[0], paper[1] - view.at[1]],
      heightMm: 5,
    };
    const err = this.edit('Add balloon', (d) => addDrawingAnnotation(d, balloon));
    if (!err) this.set({ selection: [balloon.id] });
    return err;
  }

  /**
   * DW4: one balloon for each part of the view's version that has none in it yet (one edit),
   * on an edge of the part's first placement the view shows, its circle out beyond the view
   * on the line from the view's centre through that edge, clear of the others.
   */
  addBalloons(viewId: string) {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const doc = this.current.content;
    const view = doc.views.find((v) => v.id === viewId);
    const st = this.current.views.get(viewId);
    if (!view || st?.status !== 'ready' || !st.graphics.frame)
      return this.refuse({ code: 'view-pending' });
    const parts = st.graphics.parts;
    const frame = st.graphics.frame;
    if (!parts?.rows.length) return this.refuse({ code: 'part-none' });
    const have = new Set(
      doc.annotations.flatMap((a) =>
        a.kind === 'balloon' && a.viewId === viewId
          ? [drawingPartRowOf(parts, a.ref)?.key ?? '']
          : [],
      ),
    );
    const [[bx0, by0], [bx1, by1]] = st.graphics.bounds;
    const centre: Vec2 = [(bx0 + bx1) / 2, (by0 + by1) / 2];
    const r = drawingBalloonRadius(5);
    const placed: Vec2[] = doc.annotations.flatMap((a) =>
      a.kind === 'balloon' && a.viewId === viewId
        ? [[view.at[0] + a.at[0], view.at[1] + a.at[1]] as Vec2]
        : [],
    );
    const list: DrawingBalloon[] = [];
    const targets: Vec2[] = [];
    let probe = doc;
    for (const row of parts.rows) {
      if (have.has(row.key)) continue;
      // An edge of the part's first placement in the view, the outermost (its middle farthest
      // from the view's centre, above the centre when it can be), so the line stays short.
      const all = (st.graphics.features ?? []).filter(
        (f) => drawingPartRowOf(parts, f.anchor)?.key === row.key,
      );
      // The point a balloon's line ends on: the edge's middle, or in a detail the middle of what
      // the circle keeps of it (a long edge may run far past the detail; Codex on #1228). None
      // when the detail keeps nothing of the edge.
      const clip = frame.clipRadius;
      const pointOf = (f: (typeof all)[number]): [number, number, number] | undefined => {
        const along = f.runs?.flat();
        const mid: [number, number, number] = f.circle
          ? [...f.start]
          : along?.length
            ? [...along[Math.floor(along.length / 2)]!]
            : [
                (f.start[0] + f.end[0]) / 2,
                (f.start[1] + f.end[1]) / 2,
                (f.start[2] + f.end[2]) / 2,
              ];
        if (clip === undefined) return mid;
        const r = clip - 0.5;
        if (!f.runs?.length) {
          // A straight edge: the piece the circle keeps, worked out exactly (a long edge may cross
          // a small detail between any samples; Codex on #1228).
          const a = drawingPaperOf(frame, view.at, f.start);
          const b = drawingPaperOf(frame, view.at, f.end);
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const fx = a[0] - view.at[0];
          const fy = a[1] - view.at[1];
          const A = dx * dx + dy * dy;
          const B = 2 * (fx * dx + fy * dy);
          const C = fx * fx + fy * fy - r * r;
          let t: number;
          if (A < 1e-12) {
            if (C > 0) return undefined;
            t = 0.5;
          } else {
            const disc = B * B - 4 * A * C;
            if (disc < 0) return undefined;
            const t0 = Math.max(0, (-B - Math.sqrt(disc)) / (2 * A));
            const t1 = Math.min(1, (-B + Math.sqrt(disc)) / (2 * A));
            if (t0 > t1) return undefined;
            t = (t0 + t1) / 2;
          }
          return [
            f.start[0] + (f.end[0] - f.start[0]) * t,
            f.start[1] + (f.end[1] - f.start[1]) * t,
            f.start[2] + (f.end[2] - f.start[2]) * t,
          ];
        }
        // A curve: the middle of its kept points inside the circle.
        const kept = f.runs.flat().filter((q) => {
          const p = drawingPaperOf(frame, view.at, q);
          return Math.hypot(p[0] - view.at[0], p[1] - view.at[1]) <= r;
        });
        const q = kept[Math.floor(kept.length / 2)];
        return q && [q[0], q[1], q[2]];
      };
      // A drawn edge when it has one (a part wholly behind another has only hidden ones). A
      // detail keeps the edges outside its circle undrawn too: those parts are not in it.
      const drawn = all.filter((f) => f.pickable !== false && pointOf(f));
      const features = drawn.length ? drawn : all.filter((f) => pointOf(f));
      const first = features[0];
      if (!first) continue;
      const scored = features
        .filter((f) => f.anchor.path.join('/') === first.anchor.path.join('/'))
        .map((f) => {
          const p = drawingPaperOf(frame, view.at, pointOf(f)!);
          return {
            f,
            p,
            out: Math.hypot(p[0] - centre[0], p[1] - centre[1]) + (p[1] >= centre[1] ? 1000 : 0),
          };
        });
      const { f } = scored.reduce((a, b) => (b.out > a.out ? b : a));
      const mid = pointOf(f)!;
      const ref: DrawingRef = {
        path: [...f.anchor.path],
        bodyId: f.anchor.bodyId,
        edge: f.anchor.edge,
        point: 'edge',
        model: mid,
        ...(f.name !== undefined ? { name: f.name } : {}),
      };
      const target = drawingPaperOf(frame, view.at, mid);
      let d: Vec2 = [target[0] - centre[0], target[1] - centre[1]];
      const n = Math.hypot(d[0], d[1]);
      // On the centre itself: out to the left.
      d = n > 1e-6 ? [d[0] / n, d[1] / n] : [-1, 0];
      // Never under the view, where its label is: to the side instead.
      const under = (u: Vec2) => u[1] < -0.2;
      if (under(d)) d = [d[0] < 0 ? -1 : d[0] > 0 ? 1 : -1, 0];
      // Out to where the line from the centre leaves the view's box, then 10 mm and the circle.
      const outAt = (u: Vec2, extra: number): Vec2 => {
        const tx = u[0] ? Math.max((bx0 - centre[0]) / u[0], (bx1 - centre[0]) / u[0]) : Infinity;
        const ty = u[1] ? Math.max((by0 - centre[1]) / u[1], (by1 - centre[1]) / u[1]) : Infinity;
        // Further while a slanting line keeps the circle near the box: 10 mm clear of it.
        const gap = 10 + r + extra;
        const clear = ([x, y]: Vec2) =>
          Math.hypot(Math.max(bx0 - x, 0, x - bx1), Math.max(by0 - y, 0, y - by1)) >= gap;
        let t = Math.min(tx, ty) + gap;
        for (let k = 0; k < 400 && !clear([centre[0] + u[0] * t, centre[1] + u[1] * t]); k++)
          t += 1;
        return [centre[0] + u[0] * t, centre[1] + u[1] * t];
      };
      // Clear of the circles already out there: round the view a step at a time, each step out
      // past the box again, never under it; a ring further out when one round is full (Codex
      // on #1228).
      const free = (q: Vec2) =>
        !placed.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 2 * r + 2);
      const start = Math.atan2(d[1], d[0]);
      let at = outAt(d, 0);
      search: for (let ring = 0; ring < 20 && !free(at); ring++)
        for (let k = ring ? 0 : 1; k < 53; k++) {
          const angle = start + 0.12 * k;
          const u: Vec2 = [Math.cos(angle), Math.sin(angle)];
          if (under(u)) continue;
          const q = outAt(u, ring * (2 * r + 2));
          if (free(q)) {
            at = q;
            break search;
          }
        }
      placed.push(at);
      const balloon: DrawingBalloon = {
        id: freshDrawingId(probe, 'balloon'),
        sheetId: view.sheetId,
        kind: 'balloon',
        viewId,
        ref,
        at: [
          Math.round((at[0] - view.at[0]) * 10) / 10,
          Math.round((at[1] - view.at[1]) * 10) / 10,
        ],
        heightMm: 5,
      };
      list.push(balloon);
      targets.push([target[0] - view.at[0], target[1] - view.at[1]]);
      probe = { ...probe, annotations: [...probe.annotations, balloon] };
    }
    if (!list.length) return this.refuse({ code: 'part-none' });
    // Lines that cross swap their circles, until none of the new ones cross.
    const crosses = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
      const side = (p: Vec2, q: Vec2, r: Vec2) =>
        Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
      return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
    };
    for (let pass = 0, swapped = true; swapped && pass < 20; pass++) {
      swapped = false;
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          if (crosses(list[i]!.at, targets[i]!, list[j]!.at, targets[j]!)) {
            [list[i]!.at, list[j]!.at] = [list[j]!.at, list[i]!.at];
            swapped = true;
          }
    }
    const err = this.edit('Add balloons', (d) => addDrawingAnnotations(d, list));
    if (!err) this.set({ selection: list.map((b) => b.id) });
    return err;
  }

  /**
   * DW4: the view's parts list, standing on the title block (on the revision table when the
   * sheet has one), its right edge on theirs. Of a building view (DW5c), its member list.
   */
  addPartsList(viewId: string) {
    const doc = this.current.content;
    const view = doc.views.find((v) => v.id === viewId);
    if (!view) return this.refuse({ code: 'view-missing' });
    const st = this.current.views.get(viewId);
    const members = st?.status === 'ready' ? st.graphics.members : undefined;
    // DW5c: a building view's list is its member list.
    if (!(members ?? this.partsOf(viewId)?.rows ?? []).length)
      return this.refuse({ code: drawingIsBuildingView(view) ? 'member-none' : 'part-none' });
    const sheet = doc.sheets.find((s) => s.id === view.sheetId)!;
    const layout = drawingSheetLayout(sheet);
    // On the revision table when there is one, else on the title block.
    const under = layout.revisions ?? layout.title;
    const at: Vec2 = [under.x + under.width, under.y + under.height];
    const list: DrawingPartsList = {
      id: freshDrawingId(doc, 'parts'),
      sheetId: view.sheetId,
      kind: 'parts-list',
      viewId,
      at,
      heightMm: 3.5,
    };
    // DW8: a tall list standing on the title block can reach up into a view; then it goes to a
    // free corner of the frame (top right first), or the nearest free spot.
    const box = drawingAnnotationGraphics(
      { ...doc, annotations: [list] },
      list,
      this.current.views,
    ).bounds;
    if (box) {
      const size: Vec2 = [box[1][0] - box[0][0], box[1][1] - box[0][1]];
      const hits = doc.views.some((v) => {
        const g = v.sheetId === view.sheetId ? this.current.views.get(v.id) : undefined;
        if (g?.status !== 'ready') return false;
        const [[a0, b0], [a1, b1]] = g.graphics.bounds;
        return box[1][0] > a0 && box[0][0] < a1 && box[1][1] > b0 && box[0][1] < b1;
      });
      if (hits) {
        const f = layout.frame;
        const pad = 5;
        // freeSpot works on centres; the list's anchor is its lower right corner.
        const off: Vec2 = [
          at[0] - (box[0][0] + box[1][0]) / 2,
          at[1] - (box[0][1] + box[1][1]) / 2,
        ];
        const centre = (x1: number, y1: number): Vec2 => [x1 - size[0] / 2, y1 - size[1] / 2];
        const c = this.freeSpot(view.sheetId, size, [
          centre(f.x + f.width - pad, f.y + f.height - pad),
          centre(f.x + pad + size[0], f.y + f.height - pad),
          centre(f.x + pad + size[0], f.y + pad + size[1] + 12),
        ]);
        list.at = [c[0] + off[0], c[1] + off[1]];
      }
    }
    const err = this.edit(members ? 'Add member list' : 'Add parts list', (d) =>
      addDrawingAnnotation(d, list),
    );
    if (!err) this.set({ selection: [list.id] });
    return err;
  }

  /**
   * DW4b (組立からの部品図の一括作成): a part drawing for each row of an assembly view's parts
   * list that has none yet: a new sheet (the assembly sheet's size and title block, the part's
   * name, number and quantity) with the three standard views of the part at a scale that fits,
   * and the outline and hole dimensions as candidates (DW-U4). A saved part version is drawn
   * from that version; the assembly's own body from the assembly with only that body. A part
   * with no saved version (imported into the assembly) is left out and named in the notice.
   * One edit.
   */
  async addPartDrawings(viewId: string): Promise<string | undefined> {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const sources = this.options.sources;
    const derive = this.options.derive;
    if (!sources || !derive) return this.refuse({ code: 'source-unavailable' });
    const start = this.current.content;
    const hash0 = this.current.hash;
    const view = start.views.find((v) => v.id === viewId);
    const st = this.current.views.get(viewId);
    if (view?.kind !== 'cad-projection' || st?.status !== 'ready')
      return this.refuse({ code: 'view-pending' });
    const parts = st.graphics.parts;
    // A part's own view (a body drawn alone) is no assembly to draw parts of (Codex on #1232).
    if (!drawingIsAssembly(parts) || view.only.length) return this.refuse({ code: 'part-none' });
    const asm = start.sources.find((x) => x.id === view.sourceId);
    if (!asm) return this.refuse({ code: 'source-missing' });
    const sheet0 = start.sheets.find((x) => x.id === view.sheetId)!;
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((x, i) => x === b[i]);
    const plans: {
      row: (typeof parts.rows)[number];
      target: { artifactId: string; versionId: string; contentHash: string; only: string[] };
      box: [[number, number, number], [number, number, number]];
    }[] = [];
    const skipped: string[] = [];
    for (const row of parts.rows) {
      const target = row.source
        ? { ...row.source, only: [] as string[] }
        : row.bodyId
          ? {
              artifactId: asm.artifactId,
              versionId: asm.versionId,
              contentHash: asm.contentHash,
              only: [row.bodyId],
            }
          : undefined;
      if (!target) {
        skipped.push(row.item);
        continue;
      }
      // Drawn already: a view of that version and those bodies on another sheet.
      const drawn = start.views.some(
        (v) =>
          v.kind === 'cad-projection' &&
          v.sheetId !== view.sheetId &&
          same(v.only, target.only) &&
          start.sources.some(
            (x) =>
              x.id === v.sourceId &&
              x.artifactId === target.artifactId &&
              x.versionId === target.versionId &&
              x.contentHash === target.contentHash,
          ),
      );
      if (drawn) continue;
      const prepared = await sources.prepare(
        { key: '', kind: 'cad', ...target, name: row.name, label: row.name },
        target.only,
      );
      if ('code' in prepared || !prepared.box) {
        skipped.push(row.item);
        continue;
      }
      plans.push({ row, target, box: prepared.box });
    }
    if (!plans.length)
      return this.refuse(
        skipped.length
          ? { code: 'part-drawing-none', path: skipped.join(', ') }
          : { code: 'part-drawn' },
      );
    if (this.current.hash !== hash0) return this.refuse({ code: 'drawing-base-mismatch' });

    let next = start;
    const made: { sheetId: string; views: DrawingCadView[] }[] = [];
    const stateOf = new Map<string, DrawingViewState>();
    const dims: DrawingDimension[] = [];
    const third = start.projection === 'third-angle';
    const abort = new AbortController();
    try {
      plan: for (const p of plans) {
        const before = next;
        const sheetId = freshDrawingId(next, 'sheet');
        // CAD names may be longer than drawing text (256 against 200 code points; Codex on
        // #1232): cut to fit, never refused.
        const fit = (t: string, n: number = drawingLimits.textCodePoints) =>
          [...t.replace(/\p{Cc}/gu, ' ')].slice(0, n).join('');
        const name = fit(p.row.name) || `Part ${p.row.item}`;
        const sheet: DrawingSheet = {
          ...newDrawingSheet(
            sheetId,
            fit(`${p.row.item} ${name}`, 80),
            sheet0.size,
            sheet0.orientation,
          ),
          filing: sheet0.filing,
          title: {
            ...sheet0.title,
            title: name,
            drawingNumber: fit(p.row.partNumber),
            material: '',
            quantity: String(p.row.quantity),
          },
        };
        next = addDrawingSheet(next, sheet);
        const used = useDrawingSource(next, {
          id: freshDrawingId(next, 'source'),
          kind: 'cad',
          artifactId: p.target.artifactId,
          versionId: p.target.versionId,
          contentHash: p.target.contentHash,
          name,
        });
        next = used.doc;
        // Room round the views for the dimension lines: 24 mm first; when the candidates need
        // more (many hole places), laid out again with that room (Codex on #1232).
        let room = { left: 24, right: 24, top: 24, bottom: 24, gap: 44 };
        for (let attempt = 0; ; attempt++) {
          const { scale, at } = this.threeViewLayout(sheet, p.box, next.projection, room);
          let trial = next;
          const views: DrawingCadView[] = [];
          for (const direction of ['front', 'top', 'right'] as const) {
            const v: DrawingCadView = {
              id: freshDrawingId(trial, 'view'),
              sheetId,
              sourceId: used.sourceId,
              kind: 'cad-projection',
              name: viewNames[direction],
              at: at[direction],
              scale,
              label: true,
              direction,
              only: [...p.target.only],
              hiddenLines: true,
              centerLines: true,
            };
            trial = addDrawingView(trial, v);
            views.push(v);
          }
          // Derived now, so the candidates can name their edges; kept for the views once added.
          const states = await Promise.all(
            views.map((v) =>
              derive.run(trial, v, abort.signal).catch(
                (e: unknown): DrawingViewState => ({
                  status: 'failed',
                  code: e instanceof Error && e.message ? e.message : 'derive-failed',
                }),
              ),
            ),
          );
          // A view that cannot be drawn now (too large, too slow): the part is left out and
          // named, not kept as a finished drawing without its dimensions (Codex on #1232).
          if (states.some((x) => x.status !== 'ready')) {
            next = before;
            skipped.push(p.row.item);
            continue plan;
          }
          const ready = states.map((s) => (s.status === 'ready' ? s.graphics : undefined));
          // The holes go on the view that sees the most of them face-on (the front on a tie).
          const counts = ready.map((g) => (g ? drawingHoleCircles(g).length : 0));
          const holesIn = counts.indexOf(Math.max(...counts));
          const mine: DrawingDimension[] = [];
          // How far the dimensions reach past each view, per side: the outer sides set the room
          // round the views, the sides facing another view the gap between them.
          const over = { left: 0, right: 0, top: 0, bottom: 0 };
          let inner = 0;
          views.forEach((v, i) => {
            const g = ready[i];
            if (!g) return;
            // The width and height on the front, the depth up the top view (DW-U4).
            const front = v.direction === 'front';
            const top = v.direction === 'top';
            const [[x0, y0], [x1, y1]] = g.bounds;
            const mineOver = { left: 0, right: 0, top: 0, bottom: 0 };
            for (const c of drawingCandidateDimensions(g, v.at, {
              width: front,
              height: front || top,
              holes: i === holesIn && counts[i]! > 0,
              // Away from the neighbouring views: over each view (under the label only for a
              // top view under the front, first angle), and the right-hand view's to its right.
              below: top && !third,
              left: !(v.direction === 'right' && third),
            })) {
              const x = v.at[0] + c.at[0];
              const y = v.at[1] + c.at[1];
              mineOver.left = Math.max(mineOver.left, x0 - x);
              mineOver.right = Math.max(mineOver.right, x - x1);
              mineOver.bottom = Math.max(mineOver.bottom, y0 - y);
              mineOver.top = Math.max(mineOver.top, y - y1);
              mine.push({
                id: '',
                sheetId,
                kind: 'dimension',
                viewId: v.id,
                type: c.type,
                refs: c.refs,
                at: c.at,
                text: '',
                tolerance: '',
                heightMm: 3.5,
              });
            }
            for (const side of ['left', 'right', 'top', 'bottom'] as const) {
              const facing = views.some((w) => {
                if (w === v) return false;
                const dx = w.at[0] - v.at[0];
                const dy = w.at[1] - v.at[1];
                return side === 'left'
                  ? dx < -1 && Math.abs(dy) < 1
                  : side === 'right'
                    ? dx > 1 && Math.abs(dy) < 1
                    : side === 'top'
                      ? dy > 1 && Math.abs(dx) < 1
                      : dy < -1 && Math.abs(dx) < 1;
              });
              if (facing) inner = Math.max(inner, mineOver[side]);
              else over[side] = Math.max(over[side], mineOver[side]);
            }
          });
          // The text and its line past the last stacked line.
          const want = {
            left: Math.max(12, over.left + 6),
            right: Math.max(12, over.right + 6),
            top: Math.max(12, over.top + 6),
            bottom: Math.max(12, over.bottom + 6),
            gap: Math.max(30, 2 * inner + 16),
          };
          const short = (Object.keys(want) as (keyof typeof want)[]).some(
            (k) => want[k] > room[k] + 0.5,
          );
          if (short && attempt === 0) {
            room = want;
            continue;
          }
          next = trial;
          views.forEach((v, i) => stateOf.set(v.id, states[i]!));
          dims.push(...mine);
          made.push({ sheetId, views });
          break;
        }
      }
    } catch (e) {
      if (e instanceof DrawingEditError) return this.refuse({ code: e.code, path: e.path });
      throw e;
    }
    if (!made.length) return this.refuse({ code: 'part-drawing-none', path: skipped.join(', ') });
    const all = made.flatMap((m) => m.views);
    let final = next;
    try {
      for (const d of dims)
        final = addDrawingAnnotation(final, { ...d, id: freshDrawingId(final, 'dim') });
    } catch (e) {
      if (e instanceof DrawingEditError) return this.refuse({ code: e.code, path: e.path });
      throw e;
    }
    if (this.current.hash !== hash0) return this.refuse({ code: 'drawing-base-mismatch' });
    for (const v of all) {
      const s = stateOf.get(v.id)!;
      if (s.status !== 'pending') this.derived.set(v.id, { key: derive.key(final, v), state: s });
    }
    const err = this.edit('Make part drawings', () => final);
    if (err) return err;
    this.set({ sheetId: made[0]!.sheetId, selection: [] });
    if (skipped.length)
      this.set({ notice: { code: 'part-drawing-skipped', path: skipped.join(', ') } });
    return undefined;
  }

  /**
   * Three aligned views of a model box on a sheet, above its title block: the largest standard
   * scale that fits with `room` paper mm kept free round the group of views (and `gap` between
   * them), and the views' places.
   */
  private threeViewLayout(
    sheet: DrawingSheet,
    box: [[number, number, number], [number, number, number]],
    projection: DrawingDocument['projection'],
    room: { left: number; right: number; top: number; bottom: number; gap: number },
  ) {
    const layout = drawingSheetLayout(sheet);
    const under = layout.revisions ?? layout.title;
    const bottom = under.y + under.height;
    const area = {
      x: layout.frame.x + 10 + room.left,
      y: bottom + 10 + room.bottom,
      width: Math.max(1, layout.frame.width - 20 - room.left - room.right),
      height: Math.max(
        1,
        layout.frame.y + layout.frame.height - bottom - 20 - room.bottom - room.top,
      ),
    };
    const sizes = {
      front: drawingProjectedSize(box, 'front'),
      top: drawingProjectedSize(box, 'top'),
      right: drawingProjectedSize(box, 'right'),
    };
    const scale = drawingFitScale(sizes, area, room.gap);
    return { scale, at: drawingThreeViewLayout(sizes, scale, area, projection, room.gap) };
  }

  /**
   * DW3c: the refs that do not resolve now (曖昧・未解決), every sheet, for the list that lets
   * them be chosen again. Refs of views still deriving are not in it yet.
   */
  anchorIssues() {
    return drawingAnchorIssues(this.current.content, this.current.views);
  }
  /** DW3c: puts another edge under a ref of an annotation (a candidate, or one picked again). */
  rebindRef(annotationId: string, index: number, ref: DrawingRef) {
    return this.edit('Choose edge again', (d) => rebindDrawingRef(d, annotationId, index, ref));
  }

  /** DW3c-2b: the PMI items of a ready view's imported parts, as its version has them. */
  pmiOf(viewId: string): DrawingPmiLive[] | undefined {
    const st = this.current.views.get(viewId);
    return st?.status === 'ready' ? st.graphics.pmi : undefined;
  }
  /** DW3c-2b: an imported PMI annotation's item now: its state and live item. */
  pmiState(note: DrawingPmiNote) {
    return drawingPmiResolve(note, this.pmiOf(note.viewId));
  }
  /**
   * DW3c-2b: imports a view's current PMI items not yet in it as annotations (one edit), in a
   * column beside the view: datums first, then tolerances, then dimensions and datum targets.
   */
  importPmi(viewId: string) {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const doc = this.current.content;
    const view = doc.views.find((v) => v.id === viewId);
    const st = this.current.views.get(viewId);
    if (!view || st?.status !== 'ready') return this.refuse({ code: 'view-pending' });
    const have = new Set(
      doc.annotations.flatMap((a) =>
        a.kind === 'pmi' && a.viewId === viewId
          ? [JSON.stringify([a.source.path, a.source.bodyId, a.source.itemId])]
          : [],
      ),
    );
    const order = ['datum', 'geometric-tolerance', 'dimension', 'datum-target'];
    const items = (st.graphics.pmi ?? [])
      .filter((l) => l.current && !have.has(JSON.stringify([l.path, l.bodyId, l.itemId])))
      .sort((a, b) => order.indexOf(a.item.kind) - order.indexOf(b.item.kind));
    if (!items.length) return this.refuse({ code: 'pmi-none' });
    const [, [vx1, y1]] = st.graphics.bounds;
    // Clear of the views beside it on the sheet, at the height of the column.
    const top = y1 - 4;
    const low = top - Math.min(items.length, 12) * 9;
    let x1 = vx1;
    for (const v of doc.views) {
      const s = v.sheetId === view.sheetId ? this.current.views.get(v.id) : undefined;
      if (s?.status !== 'ready') continue;
      const [[bx0, by0], [bx1, by1]] = s.graphics.bounds;
      if (bx0 >= vx1 && by1 >= low && by0 <= top + 4) x1 = Math.max(x1, bx1);
    }
    const list: DrawingPmiNote[] = [];
    let probe = doc;
    items.forEach((l, i) => {
      const id = freshDrawingId(probe, 'pmi');
      const note: DrawingPmiNote = {
        id,
        sheetId: view.sheetId,
        kind: 'pmi',
        viewId,
        source: {
          path: [...l.path],
          bodyId: l.bodyId,
          itemId: l.itemId,
          assetSha256: l.assetSha256,
        },
        item: structuredClone(l.item),
        // A column right of the view (and of the views beside it), top down, 9 mm apart, 12 to
        // a column.
        at: [x1 + 12 - view.at[0] + Math.floor(i / 12) * 45, top - (i % 12) * 9 - view.at[1]],
        heightMm: 3.5,
      };
      list.push(note);
      probe = { ...probe, annotations: [...probe.annotations, note] };
    });
    const err = this.edit('Import PMI', (d) => addDrawingAnnotations(d, list));
    if (!err) this.set({ selection: list.map((n) => n.id) });
    return err;
  }
  /** DW3c-2b: takes an updated PMI item's values as confirmed (its change is reviewed). */
  confirmPmi(id: string) {
    const a = this.current.content.annotations.find((x) => x.id === id);
    if (a?.kind !== 'pmi') return this.refuse({ code: 'annotation-missing' });
    const r = this.pmiState(a);
    if (r.state !== 'updated' || !r.live) return this.refuse({ code: 'pmi-not-updated' });
    const next: DrawingPmiNote = {
      ...a,
      source: { ...a.source, assetSha256: r.live.assetSha256 },
      item: structuredClone(r.live.item),
    };
    return this.edit('Confirm PMI', (d) => updateDrawingAnnotation(d, next));
  }
  /**
   * DW3c-2b: detaches an imported PMI annotation into a hand-made one (手動の注記へ切り離す): a
   * frame or datum symbol, else a leader note, with what it says now, pointing where it points;
   * it follows the PMI no more.
   */
  detachPmi(id: string) {
    const doc = this.current.content;
    const a = doc.annotations.find((x) => x.id === id);
    if (a?.kind !== 'pmi') return this.refuse({ code: 'annotation-missing' });
    const view = doc.views.find((v) => v.id === a.viewId);
    if (!view) return this.refuse({ code: 'view-missing' });
    const r = this.pmiState(a);
    const item = r.state === 'ok' || r.state === 'updated' ? r.live!.item : a.item;
    const at: Vec2 = [view.at[0] + a.at[0], view.at[1] + a.at[1]];
    // The arrow's tip as drawn now (the target), or the text's place when it points nowhere.
    const st = this.current.views.get(view.id);
    const frame = st?.status === 'ready' ? st.graphics.frame : undefined;
    const target: Vec2 =
      r.live?.target && frame && r.state !== 'expired'
        ? drawingPaperOf(frame, view.at, r.live.target)
        : at;
    const leader: DrawingAnnotation = {
      id,
      sheetId: a.sheetId,
      kind: 'leader',
      viewId: '',
      ref: null,
      target,
      at,
      text: drawingPmiText(item),
      heightMm: a.heightMm,
    };
    // The symbol it drew as, when the drawing can hold it as a manual one (a datum letter drawn
    // once, a frame's datum rules); otherwise what it says, as leader text.
    const spec = drawingPmiSymbol(item);
    let next: DrawingAnnotation = leader;
    if (spec) {
      const symbol: DrawingAnnotation = {
        id,
        sheetId: a.sheetId,
        kind: 'symbol',
        viewId: '',
        ref: null,
        target,
        at,
        symbol: spec,
        heightMm: a.heightMm,
      };
      try {
        updateDrawingAnnotation(doc, symbol);
        next = symbol;
      } catch {
        // The leader text.
      }
    }
    return this.edit('Detach PMI', (d) => updateDrawingAnnotation(d, next));
  }

  /** A dimension's or leader's drawing now: items, status, value (DW3). */
  annotationGraphics(a: DrawingAnnotation) {
    return drawingAnnotationGraphics(this.current.content, a, this.current.views);
  }
  updateView(view: DrawingView) {
    return this.edit('Edit view', (d) => updateDrawingView(d, view));
  }
  moveSelection(delta: Vec2) {
    if (!this.current.selection.length) return this.refuse({ code: 'selection-empty' });
    return this.edit('Move', (d) => moveDrawingItems(d, this.current.selection, delta));
  }
  deleteSelection() {
    if (!this.current.selection.length) return this.refuse({ code: 'selection-empty' });
    return this.edit('Delete', (d) => deleteDrawingItems(d, this.current.selection));
  }
  deleteSheet() {
    if (this.issueSaving) return this.refuse({ code: 'issue-busy' });
    return this.edit('Delete sheet', (d) => deleteDrawingItems(d, [this.sheet.id]));
  }

  /**
   * Places views of a saved CAD version on the sheet on screen: three aligned views (the
   * drawing's projection method) or one, at `scale` or the largest standard scale that fits the
   * area above the title block. The version is kept with the drawing first.
   */
  async addCadViews(
    choice: DrawingSourceChoice,
    set: DrawingViewSet,
    scale: DrawingScale | 'fit',
  ): Promise<string | undefined> {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const sources = this.options.sources;
    if (!sources) return this.refuse({ code: 'source-unavailable' });
    const prepared = await sources.prepare(choice);
    if ('code' in prepared) return this.refuse({ code: prepared.code });
    // A building version's views are its own plans and sections (`addBimView`).
    if (choice.kind !== 'cad' || !prepared.box) return this.refuse({ code: 'source-kind' });
    const box = prepared.box;
    const sheet = this.sheet;
    const layout = drawingSheetLayout(sheet);
    const bottom = (layout.revisions ?? layout.title).y + (layout.revisions ?? layout.title).height;
    const area = {
      x: layout.frame.x + 10,
      y: bottom + 10,
      width: layout.frame.width - 20,
      height: layout.frame.y + layout.frame.height - bottom - 20,
    };
    const doc = this.current.content;
    const directions: DrawingDirection[] = set === 'three' ? ['front', 'top', 'right'] : [set];
    const sizes = {
      front: drawingProjectedSize(box, directions[0]!),
      top: drawingProjectedSize(box, 'top'),
      right: drawingProjectedSize(box, 'right'),
    };
    const s: DrawingScale =
      scale !== 'fit'
        ? scale
        : set === 'three'
          ? drawingFitScale(sizes, area)
          : drawingFitScale({ front: sizes.front, top: [0, 0], right: [0, 0] }, area, 0);
    const at =
      set === 'three'
        ? drawingThreeViewLayout(sizes, s, area, doc.projection)
        : { front: [area.x + area.width / 2, area.y + area.height / 2] as Vec2 };
    const source: DrawingSource = {
      id: freshDrawingId(doc, 'source'),
      kind: 'cad',
      artifactId: choice.artifactId,
      versionId: choice.versionId,
      contentHash: choice.contentHash,
      name: choice.name,
    };
    const ids: string[] = [];
    const err = this.edit(set === 'three' ? 'Add three views' : 'Add view', (d) => {
      const used = useDrawingSource(d, source);
      let next = used.doc;
      for (const direction of directions) {
        const id = freshDrawingId(next, 'view');
        ids.push(id);
        const view: DrawingCadView = {
          id,
          sheetId: sheet.id,
          sourceId: used.sourceId,
          kind: 'cad-projection',
          name: viewNames[direction],
          at:
            set === 'three'
              ? (at as Record<'front' | 'top' | 'right', Vec2>)[direction as 'front']
              : at.front,
          scale: s,
          label: true,
          direction,
          only: [],
          hiddenLines: direction !== 'iso',
          centerLines: direction !== 'iso',
        };
        next = addDrawingView(next, view);
      }
      return next;
    });
    if (!err) this.set({ selection: ids });
    return err;
  }

  /**
   * DW5a: places one of a building version's own plans or sections on the sheet on screen, at
   * `scale` (the building view's own when not given).
   */
  addBimView(choice: DrawingSourceChoice, bimViewId: string, scale?: DrawingBimScale) {
    return this.addBuildingView(choice, { kind: 'bim-view', bimViewId }, scale);
  }

  /**
   * DW5a, DW5b: places a building version's view on the sheet on screen as one edit: one of its
   * own plans or sections, an elevation, a framing plan of a level or a framing elevation along
   * a grid axis. It is drawn first, so it goes where its whole drawing fits clear of the title
   * block and the other views; one that cannot be drawn now is refused with the reason. `fit`
   * (the default but for the building's own views, which keep their scale) takes the largest
   * building scale the sheet holds it at.
   */
  async addBuildingView(
    choice: DrawingSourceChoice,
    what: DrawingBuildingViewWhat,
    scale?: DrawingBimScale | 'fit',
  ): Promise<string | undefined> {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const sources = this.options.sources;
    if (!sources) return this.refuse({ code: 'source-unavailable' });
    if (choice.kind !== 'bim') return this.refuse({ code: 'source-kind' });
    let name: string;
    let own: DrawingBimScale | undefined;
    if (what.kind === 'bim-view') {
      const shown = choice.views?.find((v) => v.id === what.bimViewId);
      if (!shown) return this.refuse({ code: 'bim-view-missing' });
      [name, own] = [viewName(shown.name), shown.scale];
    } else if (what.kind === 'bim-elevation') name = elevationNames[what.side];
    else if (what.kind === 'bim-framing') {
      const level = choice.levels?.find((l) => l.id === what.levelId);
      if (!level) return this.refuse({ code: 'bim-level-missing' });
      name = viewName(level.name, ' 伏図');
    } else {
      const grid = choice.grids?.find((g) => g.id === what.gridId);
      if (!grid) return this.refuse({ code: 'bim-grid-missing' });
      name = viewName(grid.label, ' 通り軸組図');
    }
    const sheet = this.sheet;
    const layout = drawingSheetLayout(sheet);
    const middle: Vec2 = [
      layout.frame.x + layout.frame.width / 2,
      layout.frame.y + layout.frame.height / 2,
    ];
    // One entry per placement: two buildings may be drawn at once.
    let mine: DrawingPlacing | undefined;
    const shown = (k: string) => {
      const next: DrawingPlacing = { sheetId: sheet.id, name, scale: k, at: middle };
      const rest = (this.current.placing ?? []).filter((p) => p !== mine);
      mine = next;
      this.set({ placing: [...rest, next] });
    };
    shown(scale && scale !== 'fit' ? scale : (own ?? 'fit'));
    try {
      return await this.placeBuildingView(choice, what, scale, name, own, sheet, middle, shown);
    } finally {
      const rest = (this.current.placing ?? []).filter((p) => p !== mine);
      this.set({ placing: rest.length ? rest : undefined });
    }
  }

  private async placeBuildingView(
    choice: DrawingSourceChoice,
    what: DrawingBuildingViewWhat,
    scale: DrawingBimScale | 'fit' | undefined,
    name: string,
    own: DrawingBimScale | undefined,
    sheet: DrawingSheet,
    middle: Vec2,
    shown: (scale: string) => void,
  ): Promise<string | undefined> {
    const sources = this.options.sources!;
    const prepared = await sources.prepare(choice);
    if ('code' in prepared) return this.refuse({ code: prepared.code });
    const layout = drawingSheetLayout(sheet);
    const viewOf = (d: DrawingDocument, at: Vec2, s: DrawingBimScale) => {
      // Its ID from the document it goes into: another may have come while it was drawn
      // (Codex on #1237).
      const source: DrawingSource = {
        id: freshDrawingId(d, 'source'),
        kind: 'bim',
        artifactId: choice.artifactId,
        versionId: choice.versionId,
        contentHash: choice.contentHash,
        name: choice.name,
      };
      const used = useDrawingSource(d, source);
      const view = {
        id: freshDrawingId(used.doc, 'view'),
        sheetId: sheet.id,
        sourceId: used.sourceId,
        name,
        at,
        scale: s,
        label: true,
        ...what,
      } as DrawingBuildingView;
      return { doc: addDrawingView(used.doc, view), view };
    };
    let at = middle;
    let s: DrawingBimScale = scale && scale !== 'fit' ? scale : (own ?? '1:100');
    const derive = this.options.derive;
    if (derive) {
      const run = async (k: DrawingBimScale) => {
        shown(k);
        const trial = viewOf(this.current.content, [0, 0], k);
        return derive.run(trial.doc, trial.view, new AbortController().signal).catch(
          (e: unknown): DrawingViewState => ({
            status: 'failed',
            code: e instanceof Error && e.message ? e.message : 'derive-failed',
          }),
        );
      };
      let st: DrawingViewState;
      try {
        st = await run(s);
        // Fit: the largest scale whose drawing, as derived at that scale, the frame holds. Text
        // and symbols keep their paper size, so no scale's size follows from another's: each is
        // drawn and checked, largest first (Codex on #1238).
        if (st.status === 'ready' && (scale === 'fit' || (!scale && !own))) {
          const room: Vec2 = [
            layout.frame.width - 20,
            layout.frame.height - layout.title.height - 20,
          ];
          const over = (v: DrawingViewState) => {
            if (v.status !== 'ready') return false;
            const [[a0, b0], [a1, b1]] = v.graphics.bounds;
            return a1 - a0 > room[0] || b1 - b0 > room[1];
          };
          const first = s;
          const tried = st;
          for (const k of drawingBimScales) {
            s = k;
            st = k === first ? tried : await run(k);
            if (st.status !== 'ready' || !over(st)) break;
          }
        }
      } catch (e) {
        if (e instanceof DrawingEditError) return this.refuse({ code: e.code, path: e.path });
        throw e;
      }
      if (st.status === 'failed') return this.refuse({ code: st.code });
      // The sheet may have gone while the building was drawn (Codex on #1237).
      if (!this.current.content.sheets.some((x) => x.id === sheet.id))
        return this.refuse({ code: 'sheet-missing' });
      if (st.status === 'ready') {
        // Its box round `at` = [0, 0]: placed so the whole box is where the free spot is.
        const [[x0, y0], [x1, y1]] = st.graphics.bounds;
        const spot = this.freeSpot(sheet.id, [x1 - x0, y1 - y0], [middle]);
        at = [spot[0] - (x0 + x1) / 2, spot[1] - (y0 + y1) / 2];
      }
    }
    let id = '';
    const err = this.edit('Add building view', (d) => {
      const r = viewOf(d, at, s);
      id = r.view.id;
      return r.doc;
    });
    if (!err) this.set({ selection: [id] });
    return err;
  }

  /**
   * Adds a full section of a projection on screen (DW2b): a vertical cutting line (seen to the
   * left or right) or a horizontal one (seen up or down), `offset` model mm from the shape's
   * centre. The section takes the next mark and is placed in projection with its parent: on the
   * side the viewer stands (third angle), or the side it looks to (first angle).
   */
  addSection(
    parentId: string,
    look: DrawingSectionLook,
    offset = 0,
    /** DW9: the offset is from the view's centre, or from the model's origin (a shaft's axis). */
    from: 'centre' | 'origin' = 'centre',
  ) {
    const doc = this.current.content;
    const parent = doc.views.find((v) => v.id === parentId);
    if (parent?.kind !== 'cad-projection' || parent.direction === 'iso')
      return this.refuse({ code: 'view-parent-kind' });
    const state = this.current.views.get(parentId);
    if (state?.status !== 'ready' || !state.graphics.frame)
      return this.refuse({ code: 'view-pending' });
    const { center, box, scale } = state.graphics.frame;
    const pad = 8 / scale;
    const vertical = look === 'left' || look === 'right';
    let line: [Vec2, Vec2];
    if (vertical) {
      const x = (from === 'origin' ? 0 : center[0]) + offset;
      const lo: Vec2 = [x, box[0][1] - pad];
      const hi: Vec2 = [x, box[1][1] + pad];
      line = look === 'right' ? [lo, hi] : [hi, lo];
    } else {
      const y = (from === 'origin' ? 0 : center[1]) + offset;
      const lo: Vec2 = [box[0][0] - pad, y];
      const hi: Vec2 = [box[1][0] + pad, y];
      line = look === 'down' ? [lo, hi] : [hi, lo];
    }
    const mark = nextDrawingMark(doc);
    const id = freshDrawingId(doc, 'view');
    // Arrows point the way it is seen; third angle puts the view where the viewer stands. When
    // there is no room there, the other side, then any free place on the sheet (its mark names
    // it).
    const arrow: Vec2 =
      look === 'right' ? [1, 0] : look === 'left' ? [-1, 0] : look === 'up' ? [0, 1] : [0, -1];
    const side = doc.projection === 'third-angle' ? -1 : 1;
    const [[px0, py0], [px1, py1]] = state.graphics.bounds;
    const deep = (state.graphics.frame.depth[1] - state.graphics.frame.depth[0]) * scale;
    const size: Vec2 = vertical ? [deep, py1 - py0] : [px1 - px0, deep];
    const reach = vertical ? (px1 - px0) / 2 + 20 + deep / 2 : (py1 - py0) / 2 + 20 + deep / 2;
    const at = this.freeSpot(parent.sheetId, size, [
      [parent.at[0] + arrow[0] * side * reach, parent.at[1] + arrow[1] * side * reach],
      [parent.at[0] - arrow[0] * side * reach, parent.at[1] - arrow[1] * side * reach],
    ]);
    const view: DrawingCadSection = {
      id,
      kind: 'cad-section',
      sheetId: parent.sheetId,
      sourceId: parent.sourceId,
      parentId,
      name: `断面 ${mark}–${mark}`,
      at,
      scale: parent.scale,
      label: true,
      line,
      mark,
      hiddenLines: false,
      centerLines: true,
    };
    const err = this.edit('Add section', (d) => addDrawingView(d, view));
    if (!err) this.set({ sheetId: parent.sheetId, selection: [id] });
    return err;
  }

  /**
   * Adds a detail view (DW2b) of the circle of `radius` model mm (by default a sixth of the
   * parent's size) at `offset` from the parent's shape centre, at `scale` (by default the largest
   * standard scale at which it stays about 60 mm across), in a free place beside the parent.
   */
  addDetail(
    parentId: string,
    offset: Vec2,
    radius?: number,
    scale?: DrawingScale,
    /** DW9: the offset is from the view's centre, or from the model's origin. */
    from: 'centre' | 'origin' = 'centre',
  ) {
    const doc = this.current.content;
    const parent = doc.views.find((v) => v.id === parentId);
    if (
      !parent ||
      parent.kind === 'cad-detail' ||
      (parent.kind === 'cad-projection' && parent.direction === 'iso')
    )
      return this.refuse({ code: 'view-parent-kind' });
    const state = this.current.views.get(parentId);
    if (state?.status !== 'ready' || !state.graphics.frame)
      return this.refuse({ code: 'view-pending' });
    const { center, box } = state.graphics.frame;
    const r0 = radius ?? niceRadius(Math.max(box[1][0] - box[0][0], box[1][1] - box[0][1]) / 6);
    // At least one standard scale larger than the parent's; by default the largest one at which
    // the circle stays within about 60 mm on the paper.
    const i = drawingScales.indexOf(parent.scale);
    let s = scale ?? drawingScales[Math.max(0, i - 1)]!;
    if (!scale)
      for (let j = i - 1; j >= 0; j--)
        if (2 * r0 * drawingScaleFactor(drawingScales[j]!) <= 60) s = drawingScales[j]!;
        else break;
    const r = r0 * drawingScaleFactor(s);
    const [[bx0, by0], [bx1, by1]] = state.graphics.bounds;
    const my = (by0 + by1) / 2;
    const mx = (bx0 + bx1) / 2;
    const at = this.freeSpot(
      parent.sheetId,
      [2 * r, 2 * r],
      [
        [bx1 + 20 + r, my],
        [bx0 - 20 - r, my],
        [mx, by1 + 20 + r],
        [mx, by0 - 32 - r],
      ],
    );
    const mark = nextDrawingMark(doc);
    const id = freshDrawingId(doc, 'view');
    const view: DrawingCadDetail = {
      id,
      kind: 'cad-detail',
      sheetId: parent.sheetId,
      sourceId: parent.sourceId,
      parentId,
      name: `詳細 ${mark}`,
      at,
      scale: s,
      label: true,
      center: from === 'origin' ? offset : [center[0] + offset[0], center[1] + offset[1]],
      radius: r0,
      mark,
    };
    const err = this.edit('Add detail', (d) => addDrawingView(d, view));
    if (!err) this.set({ sheetId: parent.sheetId, selection: [id] });
    return err;
  }

  /** The newest saved version of a source's Artifact the Host offers, when it is another one. */
  newerVersion(sourceId: string): DrawingSourceChoice | undefined {
    const source = this.current.content.sources.find((s) => s.id === sourceId);
    if (!source || !this.options.sources) return undefined;
    const choices = this.options.sources
      .choices()
      .filter((c) => c.artifactId === source.artifactId);
    const newest = choices[0];
    if (!newest || newest.versionId === source.versionId) return undefined;
    // Only a version saved after the one seen (choices are newest first).
    const seen = choices.findIndex((c) => c.versionId === source.versionId);
    return seen === -1 || seen > 0 ? newest : undefined;
  }

  /**
   * Shows another saved version of a source in every view of it (新しい版), as one edit Undo
   * takes back. The version is kept with the drawing first.
   */
  async switchSource(sourceId: string, choice: DrawingSourceChoice): Promise<string | undefined> {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const sources = this.options.sources;
    if (!sources) return this.refuse({ code: 'source-unavailable' });
    const source = this.current.content.sources.find((s) => s.id === sourceId);
    if (!source) return this.refuse({ code: 'source-missing' });
    if (choice.artifactId !== source.artifactId) return this.refuse({ code: 'source-other' });
    const prepared = await sources.prepare(choice);
    if ('code' in prepared) return this.refuse({ code: prepared.code });
    return this.edit('Use newer version', (d) =>
      switchDrawingSource(d, sourceId, {
        versionId: choice.versionId,
        contentHash: choice.contentHash,
        name: choice.name,
      }),
    );
  }

  /**
   * A place on a sheet for a view of `size` paper mm (its label under it): the first candidate
   * whose box lies in the frame clear of the title block and the other views, else the free place
   * nearest the first candidate, else the first candidate.
   */
  private freeSpot(sheetId: string, size: Vec2, candidates: Vec2[]): Vec2 {
    const doc = this.current.content;
    const sheet = doc.sheets.find((s) => s.id === sheetId)!;
    const layout = drawingSheetLayout(sheet);
    const pad = 5;
    const busy: [Vec2, Vec2][] = [];
    for (const r of [layout.title, layout.revisions])
      if (r)
        busy.push([
          [r.x, r.y],
          [r.x + r.width, r.y + r.height],
        ]);
    for (const v of doc.views) {
      if (v.sheetId !== sheetId) continue;
      const st = this.current.views.get(v.id);
      if (st?.status === 'ready') busy.push(st.graphics.bounds);
      else
        busy.push([
          [v.at[0] - 30, v.at[1] - 20],
          [v.at[0] + 30, v.at[1] + 20],
        ]);
    }
    const f = layout.frame;
    const fits = ([x, y]: Vec2) => {
      const x0 = x - size[0] / 2;
      const x1 = x + size[0] / 2;
      const y0 = y - size[1] / 2 - 12;
      const y1 = y + size[1] / 2;
      if (x0 < f.x + pad || x1 > f.x + f.width - pad) return false;
      if (y0 < f.y + pad || y1 > f.y + f.height - pad) return false;
      return busy.every(
        ([[a0, b0], [a1, b1]]) =>
          x1 + pad <= a0 || x0 - pad >= a1 || y1 + pad <= b0 || y0 - pad >= b1,
      );
    };
    for (const c of candidates) if (fits(c)) return c;
    const want = candidates[0]!;
    let best: Vec2 | undefined;
    let dist = Infinity;
    for (let x = f.x; x <= f.x + f.width; x += 5)
      for (let y = f.y; y <= f.y + f.height; y += 5) {
        const d = Math.hypot(x - want[0], y - want[1]);
        if (d < dist && fits([x, y])) {
          best = [x, y];
          dist = d;
        }
      }
    return best ?? want;
  }

  /** DW6: once no view is still being derived. */
  private settled(): Promise<void> {
    const busy = () => [...this.current.views.values()].some((v) => v.status === 'pending');
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        if (busy()) return;
        off();
        resolve();
      });
    });
  }
  /**
   * DW6: every sheet as it prints, its views as derived once none is still being derived (a
   * view that could not be drawn prints as its placeholder with the reason).
   */
  async printSheets(): Promise<DrawingPaperSheet[]> {
    await this.settled();
    const doc = this.current.content;
    return doc.sheets.map((sheet) => ({
      name: sheet.name,
      paper: drawingSheetPaper(sheet),
      items: drawingSheetPrint(doc, sheet, this.current.views),
    }));
  }
  /** DW6: every sheet as one DXF (R2000, mm), side by side. */
  async exportDxf(): Promise<string> {
    return drawingDxf(await this.printSheets());
  }
  /** DW6: every sheet as a page of one PDF, or why not. */
  async exportPdf(): Promise<Uint8Array | string> {
    const load = this.options.pdfFont;
    if (!load) return this.refuse({ code: 'pdf-font-unavailable' });
    let font: Uint8Array;
    try {
      font = await load();
    } catch {
      return this.refuse({ code: 'pdf-font-unavailable' });
    }
    const sheets = await this.printSheets();
    try {
      return await drawingPdf(sheets, { font, title: this.current.content.name });
    } catch (e) {
      if (e instanceof DrawingPdfError)
        return this.refuse({ code: e.code, path: e.chars.slice(0, 12).join(' ') });
      throw e;
    }
  }

  /** DW6b: whether the Host keeps issues. */
  get issuing() {
    return !!this.options.issues;
  }
  /** DW6b: the Host's issues of this drawing, oldest first. */
  issued(): DrawingIssueInfo[] {
    return this.options.issues?.list() ?? [];
  }
  issuedPdf(versionId: string) {
    return this.options.issues?.pdf(versionId);
  }
  /**
   * DW6b: issues the sheets (発行): once their views are drawn and nothing on them is out of
   * date (`drawingIssueBlockers`), each gets its next revision, and the Host saves the drawing
   * as an immutable version with the PDF of those sheets as issued; then the edit is applied
   * here (Undo takes the revisions off the draft; the version and its PDF stay).
   */
  async issueSheets(
    sheetIds: readonly string[],
    /** `by` for every sheet, or each sheet's own drawn-by (表題欄の作成者) when left out. */
    revision: { description: string; date: string; by?: string },
  ): Promise<string | undefined> {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const host = this.options.issues;
    if (!host) return this.refuse({ code: 'issue-unavailable' });
    if (!this.options.pdfFont) return this.refuse({ code: 'pdf-font-unavailable' });
    if (!sheetIds.length) return this.refuse({ code: 'issue-none' });
    await this.settled();
    const base = this.current.content;
    const sheets = sheetIds.map((id) => base.sheets.find((s) => s.id === id));
    if (sheets.some((s) => !s)) return this.refuse({ code: 'sheet-missing' });
    const blocked = drawingIssueBlockers(base, this.current.views, sheetIds)[0];
    if (blocked) {
      const sheet = base.sheets.find((s) => s.id === blocked.sheetId)!;
      const a = base.annotations.find((x) => x.id === blocked.id);
      const what =
        base.views.find((v) => v.id === blocked.id)?.name ??
        (a?.kind === 'pmi'
          ? `PMI ${drawingPmiText(a.item)}`
          : a
            ? `${a.kind} ${a.id}`
            : blocked.id);
      return this.refuse({ code: blocked.code, path: `${sheet.name}: ${what}` });
    }
    const issued: DrawingIssueInfo['sheets'] = (sheets as DrawingSheet[]).map((sheet) => ({
      sheetId: sheet.id,
      name: sheet.name,
      mark: nextRevisionMark(sheet),
    }));
    // Each sheet's revision, its author its own unless one is given (Codex on #1246).
    // After the commit a sheet deleted meanwhile is skipped: the issue is kept whatever the draft
    // did since (Codex on #1246).
    const revise = (d: DrawingDocument, committed = false) =>
      issued.reduce((doc, i) => {
        const sheet = doc.sheets.find((x) => x.id === i.sheetId);
        // Skipped rather than failing once committed (deleted, or its mark taken meanwhile).
        if (committed && (!sheet || sheet.revisions.some((r) => r.mark === i.mark))) return doc;
        if (!sheet) throw new DrawingEditError('sheet-missing');
        return addDrawingRevision(doc, i.sheetId, {
          id: freshDrawingId(doc, 'rev'),
          mark: i.mark,
          date: revision.date,
          description: revision.description,
          by: revision.by ?? sheet.title.drawnBy,
        });
      }, d);
    let next: DrawingDocument;
    try {
      next = revise(base);
    } catch (e) {
      if (e instanceof DrawingEditError) return this.refuse({ code: e.code, path: e.path });
      throw e;
    }
    let font: Uint8Array;
    try {
      font = await this.options.pdfFont();
    } catch {
      return this.refuse({ code: 'pdf-font-unavailable' });
    }
    const views = this.current.views;
    let pdf: Uint8Array;
    try {
      pdf = await drawingPdf(
        (sheets as DrawingSheet[]).map((s) => {
          const sheet = next.sheets.find((x) => x.id === s.id)!;
          return {
            name: sheet.name,
            paper: drawingSheetPaper(sheet),
            items: drawingSheetPrint(next, sheet, views),
          };
        }),
        { font, title: next.name },
      );
    } catch (e) {
      if (e instanceof DrawingPdfError)
        return this.refuse({ code: e.code, path: e.chars.slice(0, 12).join(' ') });
      throw e;
    }
    // Edited meanwhile: issue what is on screen, not what was. Edit access is checked again at
    // the Host's commit too (Codex on #1246).
    if (this.current.content !== base) return this.refuse({ code: 'drawing-base-mismatch' });
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    const reason = `発行 Issue ${issued.map((i) => `${i.name} ${i.mark}`).join(', ')}`;
    this.issueSaving = true;
    let failed: string | undefined;
    try {
      failed = await host.issue({ content: next, pdf, sheets: issued, reason });
    } finally {
      this.issueSaving = false;
    }
    if (failed) return this.refuse({ code: failed });
    // Issued: the same revisions on the draft as it is now (edited while it was saved or not).
    return this.edit('Issue sheets', (d) => revise(d, true));
  }

  /** The sheet on screen as SVG (paper mm), with the views as they are derived now. */
  sheetSvg(sheetId = this.current.sheetId): string {
    const sheet = this.current.content.sheets.find((s) => s.id === sheetId)!;
    return drawingSheetSvg(this.current.content, sheet, this.current.views);
  }
  get paper(): Vec2 {
    return drawingSheetPaper(this.sheet);
  }
}
