import {
  generateFootprint,
  pcbCollections,
  pcbImportNetList,
  PcbNetListError,
  type PcbNet,
  type PcbStackedBoard,
  type PcbNetClass,
  type PcbTrack,
  type PcbVia,
  type PcbZone,
  loopBounds,
  PcbGeneratorError,
  pcbGenerators,
  type PcbComponent,
  type PcbSide,
  pcbContentHash,
  pcbBatchCommand,
  pcbEditorCommand,
  PcbOperationError,
  PcbValidationError,
  roundedRectLoop,
  type PcbBoard,
  type PcbDocument,
  type PcbHole,
  type PcbLoop,
  type PcbOperation,
  type Vec2,
} from '@editor-platform/pcb-core';
import type { EditorSession } from '@editor-platform/editor-core';

/**
 * The board Surface's state without React (docs/cad/pcb-design.md, PB1). Edits are pure
 * operations: each is one session command, applied at once; the Host saves afterwards and owns
 * Undo/Redo.
 */
export type PcbSession = Pick<EditorSession<PcbDocument>, 'content' | 'execute'>;

export interface PcbControllerOptions {
  session: PcbSession;
  /** Trusted, current edit authority; re-read by every command. */
  canEdit(): boolean;
  /** After an edit is applied: the Host saves the draft. */
  onApplied?(content: PcbDocument): void;
}

/** Why the last edit was refused: a diagnostic or operation code, its path and the IDs it names. */
export interface PcbNotice {
  code: string;
  path?: string;
  ids: string[];
}

export interface PcbState {
  content: PcbDocument;
  hash: string;
  /** Selected hole and part IDs. */
  selection: string[];
  notice?: PcbNotice;
  readOnly: boolean;
}

/** Defaults for a new mounting hole: M3 clearance with a land-sized keep-out. */
export const pcbHoleDefaults = Object.freeze({ drillMm: 3.2, keepoutMm: 6.4 });

const allIds = (doc: PcbDocument) =>
  new Set(pcbCollections.flatMap((k) => doc[k].map((e) => e.id)));
/** A new ID `prefix-n`, the lowest `n` the document does not use. */
export function pcbNewId(doc: PcbDocument, prefix: string): string {
  const used = allIds(doc);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}
/** A new reference designator `prefix` + the lowest unused number ("R1", "U3"). */
export function pcbNewRef(doc: PcbDocument, prefix: string): string {
  const used = new Set(doc.components.map((c) => c.ref));
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}
/** The board outline's size, exact along arcs. */
export function pcbBoardSize(board: PcbBoard) {
  const [x0, y0, x1, y1] = loopBounds(board.outline);
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

function noticeOf(error: unknown): PcbNotice {
  if (error instanceof PcbValidationError) {
    const d = error.diagnostics[0];
    return { code: d?.code ?? 'invalid', path: d?.path, ids: d?.id ? [d.id] : [] };
  }
  if (error instanceof PcbOperationError) return { code: error.code, ids: [] };
  if (error instanceof PcbNetListError) return { code: error.code, path: error.path, ids: [] };
  if (error instanceof PcbGeneratorError)
    return { code: 'generator-param', path: error.param, ids: [] };
  return { code: error instanceof Error ? error.message : 'failed', ids: [] };
}

export class PcbController {
  private current: PcbState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: PcbControllerOptions) {
    const content = options.session.content;
    this.current = {
      content,
      hash: pcbContentHash(content),
      selection: [],
      readOnly: !options.canEdit(),
    };
  }

  get state(): PcbState {
    return this.current;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private set(patch: Partial<PcbState>) {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }
  private refuse(notice: PcbNotice) {
    this.set({ notice });
    return notice.code;
  }
  private adopt(content: PcbDocument, patch: Partial<PcbState>) {
    const known = allIds(content);
    this.set({
      content,
      hash: pcbContentHash(content),
      selection: this.current.selection.filter((id) => known.has(id)),
      ...patch,
    });
  }

  /**
   * Applies one operation as one session command. Returns the refusal's code, which is also
   * the state's `notice`; nothing changes then.
   */
  apply(op: PcbOperation): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied', ids: [] });
    let next: PcbDocument;
    try {
      next = this.options.session.execute(
        pcbEditorCommand(op, {
          expectedHash: this.current.hash,
          canEdit: () => this.options.canEdit(),
        }),
      );
    } catch (error) {
      return this.refuse(noticeOf(error));
    }
    this.adopt(next, { notice: undefined });
    this.options.onApplied?.(next);
    return undefined;
  }

  /**
   * Several operations as one session command (one Undo), checked against the current board:
   * a schematic sent to the board (SL3). Returns the refusal's code, as `apply` does.
   */
  applyBatch(ops: PcbOperation[], label: string): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied', ids: [] });
    if (!ops.length) return this.refuse({ code: 'operation-empty', ids: [] });
    let next: PcbDocument;
    try {
      next = this.options.session.execute(
        pcbBatchCommand(ops, label, {
          expectedHash: this.current.hash,
          canEdit: () => this.options.canEdit(),
        }),
      );
    } catch (error) {
      return this.refuse(noticeOf(error));
    }
    this.adopt(next, { notice: undefined });
    this.options.onApplied?.(next);
    return undefined;
  }

  /** Host Undo, Redo or restore changed the session: show its content. */
  sync() {
    const content = this.options.session.content;
    if (pcbContentHash(content) === this.current.hash) return;
    this.adopt(content, {});
  }
  /** The Host's edit authority changed. */
  accessChanged() {
    this.set({ readOnly: !this.options.canEdit() });
  }
  select(ids: string[]) {
    const known = allIds(this.current.content);
    this.set({ selection: ids.filter((id) => known.has(id)) });
  }
  dismissNotice() {
    this.set({ notice: undefined });
  }
  /** Shows why a drawing could not become an operation (nothing changes). */
  report(notice: PcbNotice) {
    this.refuse(notice);
  }

  setBoard(patch: Partial<PcbBoard>) {
    return this.apply({ type: 'setBoard', board: { ...this.current.content.board, ...patch } });
  }
  setOutline(outline: PcbLoop) {
    return this.setBoard({ outline });
  }
  /** Replaces the outline with a `width` × `height` rectangle from the origin, corners rounded. */
  setRectangle(width: number, height: number, cornerRadius: number) {
    if (!(cornerRadius >= 0 && 2 * cornerRadius < Math.min(width, height)))
      return this.refuse({ code: 'corner-radius', ids: [] });
    return this.setOutline(roundedRectLoop([0, 0], width, height, cornerRadius));
  }
  addHole(at: Vec2, extra: Partial<Omit<PcbHole, 'id' | 'at'>> = {}) {
    const doc = this.current.content;
    const id = pcbNewId(doc, 'hole');
    const hole: PcbHole = {
      id,
      name: `H${id.slice(5)}`,
      at,
      drillMm: pcbHoleDefaults.drillMm,
      plated: false,
      keepoutMm: pcbHoleDefaults.keepoutMm,
      ...extra,
    };
    const refused = this.apply({ type: 'insert', entities: { holes: [hole] } });
    if (!refused) this.select([id]);
    return refused;
  }
  updateHole(hole: PcbHole) {
    return this.apply({ type: 'update', collection: 'holes', entity: hole });
  }
  /**
   * Places a new part made by a generator at `at`, as one edit: the footprint is added to the
   * board's library unless one with the same generator and numbers is there already. The
   * reference is the generator's letters and the lowest free number ("R1"). Returns the refusal
   * (also the `notice`), or undefined.
   */
  placeGenerated(
    kind: string,
    params: Record<string, number | string>,
    at: Vec2,
    side: PcbSide = 'top',
  ): string | undefined {
    const doc = this.current.content;
    let made;
    try {
      made = generateFootprint(pcbNewId(doc, 'fp'), kind, params);
    } catch (error) {
      return this.refuse(noticeOf(error));
    }
    const key = JSON.stringify(made.generator);
    const reuse = doc.footprints.find((f) => f.generator && JSON.stringify(f.generator) === key);
    const footprint = reuse ?? made;
    const prefix = pcbGenerators.get(kind)?.refPrefix ?? 'U';
    const id = pcbNewId({ ...doc, footprints: [...doc.footprints, made] }, 'part');
    const part: PcbComponent = {
      id,
      ref: pcbNewRef(doc, prefix),
      value: '',
      footprint: footprint.id,
      at: [Math.round(at[0] * 1e6) / 1e6 + 0, Math.round(at[1] * 1e6) / 1e6 + 0],
      rotationDeg: 0,
      side,
      locked: false,
    };
    const refused = this.apply({
      type: 'insert',
      entities: reuse ? { components: [part] } : { footprints: [made], components: [part] },
    });
    if (!refused) this.select([id]);
    return refused;
  }
  updateComponent(part: PcbComponent) {
    return this.apply({ type: 'update', collection: 'components', entity: part });
  }
  private selectedParts() {
    const ids = new Set(this.current.selection);
    return this.current.content.components.filter((c) => ids.has(c.id));
  }
  /** Turns the selected parts by `deg` about their own origins (locked parts stay). */
  rotateSelection(deg = 90) {
    const parts = this.selectedParts().filter((c) => !c.locked);
    if (!parts.length) return undefined;
    if (parts.length === 1)
      return this.updateComponent({
        ...parts[0],
        rotationDeg: (((parts[0].rotationDeg + deg) % 360) + 360) % 360,
      });
    return this.replaceParts(
      parts.map((c) => ({ ...c, rotationDeg: (((c.rotationDeg + deg) % 360) + 360) % 360 })),
    );
  }
  /** Moves the selected parts to the other side of the board (locked parts stay). */
  flipSelection() {
    const parts = this.selectedParts().filter((c) => !c.locked);
    if (!parts.length) return undefined;
    const flip = (c: PcbComponent): PcbComponent => ({
      ...c,
      side: c.side === 'top' ? 'bottom' : 'top',
    });
    if (parts.length === 1) return this.updateComponent(flip(parts[0]));
    return this.replaceParts(parts.map(flip));
  }
  /** Adds an empty net named `NETn` in the first class and selects it. */
  addNet(): string | undefined {
    const doc = this.current.content;
    const names = new Set(doc.nets.map((n) => n.name));
    let k = 1;
    while (names.has(`NET${k}`)) k++;
    const net: PcbNet = {
      id: pcbNewId(doc, 'net'),
      name: `NET${k}`,
      class: doc.netClasses[0].id,
      pins: [],
    };
    const refused = this.apply({ type: 'insert', entities: { nets: [net] } });
    if (!refused) this.select([net.id]);
    return refused;
  }
  /** PB8: puts another board's version above this one (3D only). */
  addStacked(entry: Omit<PcbStackedBoard, 'id'>) {
    const doc = this.current.content;
    return this.apply({
      type: 'insert',
      entities: { stack: [{ id: pcbNewId(doc, 'stack'), ...entry }] },
    });
  }
  updateStacked(entry: PcbStackedBoard) {
    return this.apply({ type: 'update', collection: 'stack', entity: entry });
  }
  removeStacked(id: string) {
    return this.apply({ type: 'delete', ids: [id] });
  }
  updateNet(net: PcbNet) {
    return this.apply({ type: 'update', collection: 'nets', entity: net });
  }
  /**
   * Puts a pad in `net` (or in none), taking it out of the net it was in, as one edit.
   */
  setPadNet(component: string, pad: string, net: string | undefined) {
    const doc = this.current.content;
    const same = ([c, p]: [string, string]) => c === component && p === pad;
    const nets = doc.nets.map((n) => {
      const pins = n.pins.filter((x) => !same(x));
      if (n.id === net) pins.push([component, pad]);
      return pins.length === n.pins.length && n.id !== net ? n : { ...n, pins };
    });
    return this.apply({ type: 'setNets', nets });
  }
  /** Reads a JSON net list (see `pcbImportNetList`) into the board as one edit. */
  importNets(text: string) {
    let nets;
    try {
      const doc = this.current.content;
      nets = pcbImportNetList(doc, text, (taken) => {
        for (let k = 1; ; k++) if (!taken.has(`net-${k}`)) return `net-${k}`;
      });
    } catch (error) {
      return this.refuse(noticeOf(error));
    }
    return this.apply({ type: 'setNets', nets });
  }
  addNetClass(): string | undefined {
    const doc = this.current.content;
    const names = new Set(doc.netClasses.map((n) => n.name));
    let k = 1;
    while (names.has(`Class ${k}`)) k++;
    const cls: PcbNetClass = {
      ...doc.netClasses[0],
      id: pcbNewId(doc, 'nc'),
      name: `Class ${k}`,
    };
    return this.apply({ type: 'insert', entities: { netClasses: [cls] } });
  }
  updateNetClass(cls: PcbNetClass) {
    return this.apply({ type: 'update', collection: 'netClasses', entity: cls });
  }
  deleteNetClass(id: string) {
    return this.apply({ type: 'delete', ids: [id] });
  }
  /**
   * Adds routed copper (a track run and its vias) as one edit; returns the refusal, or undefined.
   * IDs are assigned here: `trk-n` and `via-n`.
   */
  addCopper(tracks: Omit<PcbTrack, 'id'>[], vias: Omit<PcbVia, 'id'>[] = []): string | undefined {
    if (!tracks.length && !vias.length) return undefined;
    const used = allIds(this.current.content);
    const next = (prefix: string) => {
      let k = 1;
      while (used.has(`${prefix}-${k}`)) k++;
      used.add(`${prefix}-${k}`);
      return `${prefix}-${k}`;
    };
    const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    const pt = (p: Vec2): Vec2 => [r(p[0]), r(p[1])];
    const entities: { tracks?: PcbTrack[]; vias?: PcbVia[] } = {};
    if (tracks.length)
      entities.tracks = tracks.map((t) => ({
        ...t,
        id: next('trk'),
        from: pt(t.from),
        to: pt(t.to),
      }));
    if (vias.length) entities.vias = vias.map((v) => ({ ...v, id: next('via'), at: pt(v.at) }));
    return this.apply({ type: 'insert', entities });
  }
  /** A new zone of `net` on `layer` over `outline`, with the usual rules; selects it. */
  addZone(net: string, layer: string, outline: PcbLoop) {
    const used = allIds(this.current.content);
    let k = 1;
    while (used.has(`zone-${k}`)) k++;
    const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    const zone: PcbZone = {
      id: `zone-${k}`,
      net,
      layer,
      outline: outline.map((v) => (v.length === 3 ? [r(v[0]), r(v[1]), v[2]] : [r(v[0]), r(v[1])])),
      priority: 0,
      clearanceMm: 0.2,
      padConnection: 'thermal',
      thermalGapMm: 0.3,
      spokeWidthMm: 0.3,
    };
    const refused = this.apply({ type: 'insert', entities: { zones: [zone] } });
    if (!refused) this.select([zone.id]);
    return refused;
  }
  updateZone(zone: PcbZone) {
    return this.apply({ type: 'update', collection: 'zones', entity: zone });
  }
  updateTrack(track: PcbTrack) {
    return this.apply({ type: 'update', collection: 'tracks', entity: track });
  }
  updateVia(via: PcbVia) {
    return this.apply({ type: 'update', collection: 'vias', entity: via });
  }
  /** Several parts replaced as one edit. */
  private replaceParts(parts: PcbComponent[]) {
    return this.apply({ type: 'updateMany', collection: 'components', entities: parts });
  }
  /**
   * Moves the selected parts and holes by `delta` as one edit (locked parts stay). Returns the
   * refusal, or undefined.
   */
  moveSelection(delta: Vec2) {
    if (delta[0] === 0 && delta[1] === 0) return undefined;
    const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    const by = (at: Vec2): Vec2 => [r(at[0] + delta[0]), r(at[1] + delta[1])];
    const parts = this.selectedParts().filter((c) => !c.locked);
    const ids = new Set(this.current.selection);
    const holes = this.current.content.holes.filter((h) => ids.has(h.id));
    if (parts.length && !holes.length)
      return this.replaceParts(parts.map((c) => ({ ...c, at: by(c.at) })));
    if (holes.length && !parts.length)
      return this.apply({
        type: 'updateMany',
        collection: 'holes',
        entities: holes.map((h) => ({ ...h, at: by(h.at) })),
      });
    return undefined;
  }
  /** Deletes the selection; locked parts stay. A part's footprint stays in the library. */
  deleteSelection() {
    const locked = new Set(
      this.current.content.components.filter((c) => c.locked).map((c) => c.id),
    );
    const ids = this.current.selection.filter((id) => !locked.has(id));
    if (!ids.length) return undefined;
    return this.apply({ type: 'delete', ids });
  }
}
