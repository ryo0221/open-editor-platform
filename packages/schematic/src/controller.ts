import {
  generateSchematicSymbol,
  schematicContentHash,
  schematicPartSuggestion,
  SchematicSymbolError,
  schematicEditorCommand,
  SchematicOperationError,
  SchematicValidationError,
  snapSchematic,
  type SchematicCollection,
  type SchematicDocument,
  type SchematicLabel,
  type SchematicOperation,
  type SchematicPart,
  type SchematicPower,
  type SchematicPowerStyle,
  type SchematicRotation,
  type SchematicSheet,
  type SchematicSymbolParams,
  type Vec2,
} from '@editor-platform/schematic-core';
import type { EditorSession } from '@editor-platform/editor-core';

/**
 * The schematic Surface's state without React (docs/cad/circuit-simulation.md, SL1). Edits are
 * pure operations: each is one session command, applied at once; the Host saves afterwards and
 * owns Undo/Redo.
 */
export type SchematicSession = Pick<EditorSession<SchematicDocument>, 'content' | 'execute'>;

export interface SchematicControllerOptions {
  session: SchematicSession;
  /** Trusted, current edit authority; re-read by every command. */
  canEdit(): boolean;
  /** After an edit is applied: the Host saves the draft. */
  onApplied?(content: SchematicDocument): void;
}

/** Why the last edit was refused: a diagnostic or operation code, its path and the IDs it names. */
export interface SchematicNotice {
  code: string;
  path?: string;
  ids: string[];
}

export interface SchematicState {
  content: SchematicDocument;
  hash: string;
  /** Selected item IDs (parts, wires, junctions, labels, power ports). */
  selection: string[];
  notice?: SchematicNotice;
  readOnly: boolean;
}

const itemCollections = ['parts', 'wires', 'junctions', 'labels', 'powers'] as const;
const itemIds = (doc: SchematicDocument) =>
  new Set(itemCollections.flatMap((k) => doc[k].map((e) => e.id)));

/**
 * A new ID `prefix-<12 random hex digits>` that no entity of the document uses. Random, not the
 * lowest free number: a deleted item's ID is never handed out again, so saved versions and
 * ID-based pin references keep naming the item they meant (AGENTS.md, stable element IDs).
 */
export function schematicNewId(
  doc: SchematicDocument,
  prefix: string,
  random: () => string = () => crypto.randomUUID(),
): string {
  const used = new Set([...itemIds(doc), ...doc.symbols.map((s) => s.id)]);
  for (;;) {
    const id = `${prefix}-${random().replace(/-/g, '').slice(0, 12)}`;
    if (!used.has(id)) return id;
  }
}
/** The next free reference with `prefix` ("R3" after R1 and R2). */
export function schematicNextRef(doc: SchematicDocument, prefix: string): string {
  const used = new Set(doc.parts.map((p) => p.ref));
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

function noticeOf(error: unknown): SchematicNotice {
  if (error instanceof SchematicValidationError) {
    const d = error.diagnostics[0];
    return { code: d?.code ?? 'invalid', path: d?.path, ids: d?.id ? [d.id] : [] };
  }
  if (error instanceof SchematicOperationError) return { code: error.code, ids: [] };
  if (error instanceof SchematicSymbolError) return { code: error.message, ids: [] };
  return { code: error instanceof Error ? error.message : 'failed', ids: [] };
}
const nextRotation = (r: SchematicRotation): SchematicRotation =>
  ((r + 90) % 360) as SchematicRotation;

export class SchematicController {
  private current: SchematicState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: SchematicControllerOptions) {
    const content = options.session.content;
    this.current = {
      content,
      hash: schematicContentHash(content),
      selection: [],
      readOnly: !options.canEdit(),
    };
  }

  get state(): SchematicState {
    return this.current;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private set(patch: Partial<SchematicState>) {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }
  private refuse(notice: SchematicNotice) {
    this.set({ notice });
    return notice.code;
  }
  private adopt(content: SchematicDocument, patch: Partial<SchematicState>) {
    const known = itemIds(content);
    this.set({
      content,
      hash: schematicContentHash(content),
      selection: this.current.selection.filter((id) => known.has(id)),
      ...patch,
    });
  }

  /**
   * Applies one operation as one session command. Returns the refusal's code, which is also
   * the state's `notice`; nothing changes then.
   */
  apply(op: SchematicOperation): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied', ids: [] });
    let next: SchematicDocument;
    try {
      next = this.options.session.execute(
        schematicEditorCommand(op, {
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
    if (schematicContentHash(content) === this.current.hash) return;
    this.adopt(content, {});
  }
  accessChanged() {
    this.set({ readOnly: !this.options.canEdit() });
  }
  select(ids: string[]) {
    const known = itemIds(this.current.content);
    this.set({ selection: ids.filter((id) => known.has(id)) });
  }
  dismissNotice() {
    this.set({ notice: undefined });
  }
  report(notice: SchematicNotice) {
    this.refuse(notice);
  }

  setSheet(patch: Partial<SchematicSheet>) {
    return this.apply({ type: 'setSheet', sheet: { ...this.current.content.sheet, ...patch } });
  }
  private insert(
    collection: SchematicCollection,
    entity: SchematicDocument[SchematicCollection][number],
  ) {
    const refused = this.apply({ type: 'insert', entities: { [collection]: [entity] } });
    if (!refused) this.select([entity.id]);
    return refused;
  }
  /**
   * Places symbol `symbol` at `at` (snapped to the grid) with the next free reference. A part of
   * a generated symbol starts with the generator's suggestion (value, model, footprint, pins).
   */
  addPart(symbol: string, at: Vec2, rotationDeg: SchematicRotation = 0) {
    const doc = this.current.content;
    const def = doc.symbols.find((s) => s.id === symbol);
    if (!def) return this.refuse({ code: 'symbol-missing', ids: [] });
    const part: SchematicPart = {
      id: schematicNewId(doc, 'part'),
      ref: schematicNextRef(doc, def.prefix),
      symbol,
      at: snapSchematic(at),
      rotationDeg,
      mirror: false,
      ...schematicPartSuggestion(def),
    };
    return this.insert('parts', part);
  }
  /**
   * Adds a symbol made by generator `kind` from `params`. Returns its ID, or the refusal's code
   * as `refused` (a bad parameter is `symbol-param:<name>`).
   */
  addSymbol(kind: string, params: SchematicSymbolParams): { id?: string; refused?: string } {
    if (!this.options.canEdit())
      return { refused: this.refuse({ code: 'permission-denied', ids: [] }) };
    let symbol;
    try {
      symbol = generateSchematicSymbol(schematicNewId(this.current.content, 'sym'), kind, params);
    } catch (error) {
      return { refused: this.refuse(noticeOf(error)) };
    }
    const refused = this.apply({ type: 'insert', entities: { symbols: [symbol] } });
    return refused ? { refused } : { id: symbol.id };
  }
  /** Adds a wire through `points` (grid points; consecutive ones in a line). */
  addWire(points: Vec2[]) {
    const doc = this.current.content;
    return this.insert('wires', {
      id: schematicNewId(doc, 'wire'),
      points: points.map(snapSchematic),
    });
  }
  addJunction(at: Vec2) {
    const doc = this.current.content;
    return this.insert('junctions', { id: schematicNewId(doc, 'junction'), at: snapSchematic(at) });
  }
  addLabel(name: string, at: Vec2) {
    const doc = this.current.content;
    const label: SchematicLabel = {
      id: schematicNewId(doc, 'label'),
      name,
      at: snapSchematic(at),
      rotationDeg: 0,
    };
    return this.insert('labels', label);
  }
  addPower(name: string, style: SchematicPowerStyle, at: Vec2) {
    const doc = this.current.content;
    const power: SchematicPower = {
      id: schematicNewId(doc, 'power'),
      name,
      at: snapSchematic(at),
      rotationDeg: 0,
      style,
    };
    return this.insert('powers', power);
  }
  updatePart(part: SchematicPart) {
    return this.apply({ type: 'update', collection: 'parts', entity: part });
  }
  updateLabel(label: SchematicLabel) {
    return this.apply({ type: 'update', collection: 'labels', entity: label });
  }
  updatePower(power: SchematicPower) {
    return this.apply({ type: 'update', collection: 'powers', entity: power });
  }
  /** Moves the selected items (wires follow; see the `move` operation). */
  moveSelection(delta: Vec2) {
    if (!this.current.selection.length) return undefined;
    return this.apply({ type: 'move', ids: [...this.current.selection], delta });
  }
  /** Turns the selected part 90° clockwise about its origin. */
  rotateSelection() {
    const part = this.selectedPart();
    if (!part) return undefined;
    return this.updatePart({ ...part, rotationDeg: nextRotation(part.rotationDeg) });
  }
  mirrorSelection() {
    const part = this.selectedPart();
    if (!part) return undefined;
    return this.updatePart({ ...part, mirror: !part.mirror });
  }
  private selectedPart() {
    const id = this.current.selection[0];
    return this.current.content.parts.find((p) => p.id === id);
  }
  deleteSelection() {
    if (!this.current.selection.length) return undefined;
    return this.apply({ type: 'delete', ids: [...this.current.selection] });
  }
}
