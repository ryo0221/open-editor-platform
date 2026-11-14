import { canonicalJson } from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type EditorSession,
} from '@editor-platform/editor-core';
import {
  applyLadderOperation,
  ladderAddBranch,
  ladderIds,
  ladderIdentifierOk,
  ladderInitialState,
  ladderInsertSeries,
  ladderMove,
  ladderNewId,
  ladderNode,
  ladderRemove,
  ladderReplace,
  ladderScan,
  ladderVariableMap,
  LadderOperationError,
  LadderValidationError,
  type LadderCoil,
  type LadderDocument,
  type LadderNode,
  type LadderOperation,
  type LadderRung,
  type LadderState,
  type LadderType,
  type LadderValue,
  type LadderVariable,
} from '@editor-platform/ladder-core';

/**
 * The ladder Surface's state without React (docs/cad/circuit-simulation.md, SL7). Edits are
 * `ladder-core` operations: each is one session command, applied at once; the Host saves
 * afterwards and owns Undo/Redo. Running the program never changes the content: inputs, forced
 * values and the scan state live here, and edits are refused while it runs (stop, then edit).
 */
export type LadderSession = Pick<EditorSession<LadderDocument>, 'content' | 'execute'>;

export interface LadderControllerOptions {
  session: LadderSession;
  /** Trusted, current edit authority; re-read by every command. */
  canEdit(): boolean;
  /** After an edit is applied: the Host saves the draft. */
  onApplied?(content: LadderDocument): void;
  /** The clock that runs scans (tests pass their own). Default: `setInterval`. */
  every?(ms: number, run: () => void): () => void;
}

/** Why the last edit was refused: its code and the ID or path it names. */
export interface LadderNotice {
  code: string;
  id?: string;
  path?: string;
}

export interface LadderRunState {
  running: boolean;
  state: LadderState;
  /** Node and coil ID → power leaving it, from the last scan (empty before the first). */
  power: Record<string, boolean>;
  /** Input values the next scan copies in (pressed buttons, typed numbers). */
  inputs: Record<string, LadderValue>;
  /** Forced values (any BOOL, INT or TIME variable). */
  forced: Record<string, LadderValue>;
}

export interface LadderSurfaceState {
  content: LadderDocument;
  key: string;
  /** A rung, node or coil ID. */
  selection?: string;
  notice?: LadderNotice;
  readOnly: boolean;
  run: LadderRunState;
}

/** What the palette adds. */
export const ladderElementKinds = [
  'no',
  'nc',
  'rising',
  'falling',
  'timer',
  'counter',
  'compare',
] as const;
export type LadderElementKind = (typeof ladderElementKinds)[number];

const key = (doc: LadderDocument) => canonicalJson(doc);
const dict = <T>() => Object.create(null) as Record<string, T>;
const labels: Record<LadderOperation['type'], string> = {
  setProgram: 'Edit program',
  insertRung: 'Add rung',
  updateRungs: 'Edit rung',
  deleteRungs: 'Delete rung',
  moveRung: 'Move rung',
  insertVariable: 'Add variable',
  updateVariable: 'Edit variable',
  deleteVariables: 'Delete variable',
  batch: 'Edit',
};

/** One ordinary EditorSession transaction for an operation; re-checks the base and authority. */
export function ladderEditorCommand(
  op: LadderOperation,
  options: { expectedKey: string; canEdit(): boolean },
): EditorCommand<LadderDocument> {
  const prepared = structuredClone(op);
  const run = (content: LadderDocument) => {
    if (!options.canEdit()) throw new LadderOperationError('permission-denied');
    if (key(content) !== options.expectedKey)
      throw new LadderOperationError('ladder-base-mismatch');
    return applyLadderOperation(content, prepared);
  };
  return withCommandReads(immutableCommand(`ladder.${op.type}`, labels[op.type], run), {
    content: ['*'],
  });
}

function noticeOf(error: unknown): LadderNotice {
  if (error instanceof LadderValidationError) {
    const d = error.diagnostics[0];
    return { code: d?.code ?? 'invalid', id: d?.id, path: d?.path };
  }
  if (error instanceof LadderOperationError) return { code: error.code, id: error.id };
  return { code: error instanceof Error ? error.message : 'failed' };
}

/** The first free name `prefix1`, `prefix2`, … (names compare without case). */
export function ladderFreshName(doc: LadderDocument, prefix: string): string {
  const used = ladderVariableMap(doc);
  for (let n = 1; ; n++) if (!used.get(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** Where a rung, node or coil is: its rung, and the element itself. */
export function ladderFind(
  doc: LadderDocument,
  id: string | undefined,
): { rung: LadderRung; element?: LadderNode | LadderCoil } | undefined {
  if (!id) return undefined;
  for (const rung of doc.rungs) {
    if (rung.id === id) return { rung };
    const coil = rung.coils.find((c) => c.id === id);
    if (coil) return { rung, element: coil };
    const node = ladderNode(rung, id);
    if (node) return { rung, element: node };
  }
  return undefined;
}

const freshRun = (doc: LadderDocument): LadderRunState => ({
  running: false,
  state: ladderInitialState(doc),
  power: dict(),
  inputs: dict(),
  forced: dict(),
});

export class LadderController {
  private current: LadderSurfaceState;
  private readonly listeners = new Set<() => void>();
  private stopClock?: () => void;

  constructor(private readonly options: LadderControllerOptions) {
    const content = options.session.content;
    this.current = {
      content,
      key: key(content),
      readOnly: !options.canEdit(),
      run: freshRun(content),
    };
  }

  get state(): LadderSurfaceState {
    return this.current;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private set(patch: Partial<LadderSurfaceState>) {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }
  private refuse(notice: LadderNotice) {
    this.set({ notice });
    return notice.code;
  }
  private adopt(content: LadderDocument, patch: Partial<LadderSurfaceState>) {
    const known = ladderIds(content);
    const selection = this.current.selection;
    this.stop();
    this.set({
      content,
      key: key(content),
      selection: selection && known.has(selection) ? selection : undefined,
      // A changed program starts from its initial values.
      run: freshRun(content),
      ...patch,
    });
  }

  /**
   * Applies one operation as one session command. Returns the refusal's code, which is also
   * the state's `notice`; nothing changes then.
   */
  apply(op: LadderOperation): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    if (this.current.run.running) return this.refuse({ code: 'running' });
    let next: LadderDocument;
    try {
      next = this.options.session.execute(
        ladderEditorCommand(op, {
          expectedKey: this.current.key,
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
    if (key(content) === this.current.key) return;
    this.adopt(content, {});
  }
  accessChanged() {
    this.set({ readOnly: !this.options.canEdit() });
  }
  select(id: string | undefined) {
    this.set({ selection: id && ladderIds(this.current.content).has(id) ? id : undefined });
  }
  dismissNotice() {
    this.set({ notice: undefined });
  }
  report(notice: LadderNotice) {
    this.refuse(notice);
  }

  // Editing.

  private ids = new Set<string>();
  private newId(prefix: string) {
    const id = ladderNewId(this.current.content, prefix, this.ids);
    this.ids.add(id);
    return id;
  }
  /** Runs a rung helper; its refusal becomes the notice. */
  private build<T>(make: () => T): T | string {
    this.ids = new Set();
    try {
      return make();
    } catch (error) {
      return this.refuse(noticeOf(error));
    }
  }
  /** A new element of `kind`, with the variables it needs (a timer or counter instance). */
  private element(kind: LadderElementKind): { node: LadderNode; add: LadderVariable[] } {
    const doc = this.current.content;
    const id = this.newId('n');
    if (kind === 'timer' || kind === 'counter') {
      const timer = kind === 'timer';
      const name = ladderFreshName(doc, timer ? 'T' : 'C');
      const variable: LadderVariable = { name, type: timer ? 'TON' : 'CTU', role: 'internal' };
      const node: LadderNode = timer
        ? { id, kind: 'timer', instance: name, presetMs: 1000 }
        : { id, kind: 'counter', instance: name, preset: 3 };
      return { node, add: [variable] };
    }
    if (kind === 'compare')
      return {
        node: { id, kind: 'compare', op: 'eq', a: { value: 0 }, b: { value: 0 } },
        add: [],
      };
    // A contact reads the first BOOL input (a new one when there is none).
    const bool = doc.variables.find((v) => v.type === 'BOOL' && v.role === 'input');
    const name = bool?.name ?? ladderFreshName(doc, 'X');
    return {
      node: { id, kind: 'contact', variable: name, contact: kind },
      add: bool ? [] : [{ name, type: 'BOOL', role: 'input' }],
    };
  }
  /** A coil on the first BOOL output or internal variable no plain coil drives yet (else a new output). */
  private newCoil(): { coil: LadderCoil; add: LadderVariable[] } {
    const doc = this.current.content;
    const driven = new Set(
      doc.rungs.flatMap((r) =>
        r.coils.filter((c) => c.coil === 'normal').map((c) => c.variable.toUpperCase()),
      ),
    );
    const free = doc.variables.find(
      (v) => v.type === 'BOOL' && v.role !== 'input' && !driven.has(v.name.toUpperCase()),
    );
    const name = free?.name ?? ladderFreshName(doc, 'Y');
    return {
      coil: { id: this.newId('c'), variable: name, coil: 'normal' },
      add: free ? [] : [{ name, type: 'BOOL', role: 'output' }],
    };
  }
  private withVariables(add: LadderVariable[], op: LadderOperation): LadderOperation {
    if (!add.length) return op;
    return {
      type: 'batch',
      ops: [...add.map((variable) => ({ type: 'insertVariable' as const, variable })), op],
    };
  }

  /** Adds a rung with one coil below the selected rung (or at the end), and selects it. */
  addRung() {
    const made = this.build(() => {
      const { coil, add } = this.newCoil();
      const rung: LadderRung = {
        id: this.newId('r'),
        network: { id: this.newId('n'), kind: 'series', items: [] },
        coils: [coil],
      };
      return { rung, add };
    });
    if (typeof made === 'string') return made;
    const doc = this.current.content;
    const at = ladderFind(doc, this.current.selection);
    const index = at ? doc.rungs.indexOf(at.rung) + 1 : doc.rungs.length;
    const refused = this.apply(
      this.withVariables(made.add, { type: 'insertRung', rung: made.rung, index }),
    );
    if (!refused) this.select(made.rung.id);
    return refused;
  }
  /**
   * Adds an element of `kind`: in series after (or before) the selection, or as a new branch
   * below it (`branch`). A selected rung (or nothing: the last rung) takes it at its end.
   */
  addElement(kind: LadderElementKind, where: 'after' | 'before' | 'branch' = 'after') {
    const doc = this.current.content;
    const at = ladderFind(doc, this.current.selection) ?? {
      rung: doc.rungs[doc.rungs.length - 1],
    };
    if (!at.rung) return this.refuse({ code: 'no-rung' });
    if (at.element && !('kind' in at.element))
      return this.refuse({ code: 'coil-target', id: at.element.id });
    const target = at.element?.id ?? at.rung.network.id;
    const made = this.build(() => {
      const { node, add } = this.element(kind);
      const newId = () => this.newId('n');
      const rung =
        where === 'branch'
          ? ladderAddBranch(at.rung, target, node, newId)
          : ladderInsertSeries(at.rung, target, where, node, newId);
      return { rung, add, id: node.id };
    });
    if (typeof made === 'string') return made;
    const refused = this.apply(
      this.withVariables(made.add, { type: 'updateRungs', rungs: [made.rung] }),
    );
    if (!refused) this.select(made.id);
    return refused;
  }
  /** Adds a coil to the selected rung (or the last one). */
  addCoil() {
    const doc = this.current.content;
    const rung = ladderFind(doc, this.current.selection)?.rung ?? doc.rungs[doc.rungs.length - 1];
    if (!rung) return this.refuse({ code: 'no-rung' });
    const made = this.build(() => this.newCoil());
    if (typeof made === 'string') return made;
    const refused = this.apply(
      this.withVariables(made.add, {
        type: 'updateRungs',
        rungs: [{ ...rung, coils: [...rung.coils, made.coil] }],
      }),
    );
    if (!refused) this.select(made.coil.id);
    return refused;
  }
  /** Deletes the selected element, coil or rung. */
  deleteSelection() {
    const at = ladderFind(this.current.content, this.current.selection);
    if (!at) return undefined;
    if (!at.element) return this.apply({ type: 'deleteRungs', ids: [at.rung.id] });
    const id = at.element.id;
    const rung = this.build(() => ladderRemove(at.rung, id, () => this.newId('n')));
    if (typeof rung === 'string') return rung;
    return this.apply({ type: 'updateRungs', rungs: [rung] });
  }
  /**
   * Moves element `id` in series before or after `targetId` (an element, or a rung: its end).
   * Across rungs, both change in one edit.
   */
  moveElement(id: string, targetId: string, side: 'before' | 'after') {
    const doc = this.current.content;
    const from = ladderFind(doc, id);
    const to = ladderFind(doc, targetId);
    if (!from?.element || !to) return this.refuse({ code: 'not-found', id });
    if (!('kind' in from.element) || (to.element && !('kind' in to.element)))
      return this.refuse({ code: 'coil-target', id });
    const target = to.element?.id ?? to.rung.network.id;
    const newId = () => this.newId('n');
    const made = this.build(() => {
      if (from.rung === to.rung) return [ladderMove(from.rung, id, target, side, newId)];
      const node = from.element as LadderNode;
      return [
        ladderRemove(from.rung, id, newId),
        ladderInsertSeries(to.rung, target, side, node, newId),
      ];
    });
    if (typeof made === 'string') return made;
    return this.apply({ type: 'updateRungs', rungs: made });
  }
  /** Replaces the leaf element or coil with the same ID. */
  replace(element: LadderNode | LadderCoil) {
    const at = ladderFind(this.current.content, element.id);
    if (!at?.element) return this.refuse({ code: 'not-found', id: element.id });
    const rung = this.build(() => ladderReplace(at.rung, element));
    if (typeof rung === 'string') return rung;
    return this.apply({ type: 'updateRungs', rungs: [rung] });
  }
  /** Sets the comment of rung `id` (empty removes it). */
  setRungComment(id: string, comment: string) {
    const at = ladderFind(this.current.content, id);
    if (!at) return this.refuse({ code: 'not-found', id });
    const { comment: _, ...rest } = at.rung;
    return this.apply({
      type: 'updateRungs',
      rungs: [comment ? { ...rest, comment } : rest],
    });
  }
  /** Moves the selected element's rung up (-1) or down (+1). */
  moveRung(id: string, by: -1 | 1) {
    const i = this.current.content.rungs.findIndex((r) => r.id === id);
    if (i < 0) return this.refuse({ code: 'not-found', id });
    const to = i + by;
    if (to < 0 || to >= this.current.content.rungs.length) return undefined;
    return this.apply({ type: 'moveRung', id, index: to });
  }
  setProgram(patch: { name?: string; scanMs?: number }) {
    return this.apply({ type: 'setProgram', ...patch });
  }
  /** Adds a BOOL internal variable with a fresh name (or `variable`). */
  addVariable(variable?: LadderVariable) {
    const v = variable ?? {
      name: ladderFreshName(this.current.content, 'M'),
      type: 'BOOL' as LadderType,
      role: 'internal' as const,
    };
    return this.apply({ type: 'insertVariable', variable: v });
  }
  /** Replaces variable `name`; a new name renames its uses. */
  updateVariable(name: string, variable: LadderVariable) {
    if (!ladderIdentifierOk(variable.name))
      return this.refuse({ code: 'name-invalid', id: variable.name });
    return this.apply({ type: 'updateVariable', name, variable });
  }
  deleteVariable(name: string) {
    return this.apply({ type: 'deleteVariables', names: [name] });
  }

  // Running.

  private setRun(patch: Partial<LadderRunState>) {
    this.set({ run: { ...this.current.run, ...patch } });
  }
  /** One scan with the current inputs and forced values. */
  step() {
    const { content } = this.current;
    const r = this.current.run;
    const { state, power } = ladderScan(content, r.state, r.inputs, r.forced);
    this.setRun({ state, power });
  }
  /** Scans every `scanMs` until `stop` (virtual time advances by `scanMs` per scan). */
  start() {
    if (this.current.run.running) return;
    this.setRun({ running: true });
    const every =
      this.options.every ??
      ((ms, run) => {
        const t = setInterval(run, ms);
        return () => clearInterval(t);
      });
    this.stopClock = every(this.current.content.scanMs, () => this.step());
  }
  stop() {
    this.stopClock?.();
    this.stopClock = undefined;
    if (this.current.run.running) this.setRun({ running: false });
  }
  /** Back to the initial values (inputs and forcing are cleared too). */
  reset() {
    this.stop();
    this.set({ run: freshRun(this.current.content) });
  }
  /**
   * Whether `value` fits variable `name`'s type: BOOL a boolean, INT a whole number in
   * -32768..32767, TIME whole milliseconds in 0..2^31-1 (as `validateLadder` checks initial
   * values). Returns the declared name, or undefined.
   */
  private fits(name: string, value: LadderValue, roles: readonly string[]) {
    const v = ladderVariableMap(this.current.content).get(name);
    if (!v || !roles.includes(v.role)) return undefined;
    const int = (lo: number, hi: number) =>
      typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi;
    const ok =
      v.type === 'BOOL'
        ? typeof value === 'boolean'
        : v.type === 'INT'
          ? int(-32768, 32767)
          : v.type === 'TIME'
            ? int(0, 2 ** 31 - 1)
            : false;
    return ok ? v.name : undefined;
  }
  /**
   * Sets input `name` for the next scans (a held button is true until released). A value that
   * does not fit the input's type, or a name that is no input, is refused (`input-value`).
   */
  setInput(name: string, value: LadderValue) {
    const declared = this.fits(name, value, ['input']);
    if (!declared) return this.refuse({ code: 'input-value', id: name });
    this.setRun({
      inputs: Object.assign(dict<LadderValue>(), this.current.run.inputs, { [declared]: value }),
    });
    return undefined;
  }
  /** Forces `name` to `value`, or releases it (undefined); a value off its type is refused. */
  force(name: string, value: LadderValue | undefined) {
    const forced = Object.assign(dict<LadderValue>(), this.current.run.forced);
    if (value === undefined) {
      // Released by any spelling of the name (names compare without case).
      const declared = ladderVariableMap(this.current.content).get(name)?.name ?? name;
      delete forced[declared];
    } else {
      const declared = this.fits(name, value, ['input', 'output', 'internal']);
      if (!declared) return this.refuse({ code: 'input-value', id: name });
      forced[declared] = value;
    }
    this.setRun({ forced });
    return undefined;
  }
  dispose() {
    this.stop();
  }
}
