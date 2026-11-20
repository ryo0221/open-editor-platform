import { canonicalJson } from '@editor-platform/artifact-core';
import type { EditorSession } from '@editor-platform/editor-core';
import {
  FactoryValidationError,
  factoryContentHash,
  factoryEditorCommand,
  freshFactoryId,
  readFactoryTimesCsv,
  startFactoryRun,
  type FactoryDocument,
  type FactoryLink,
  type FactoryObject,
  type FactoryObjectKind,
  type FactoryOperation,
  type FactoryPlacement,
  type FactoryRunProgress,
  type FactoryRunResult,
  factoryExperimentOf,
  factoryExperimentSize,
  runFactoryExperiment,
  type FactoryExperiment,
  type FactoryExperimentRun,
} from '@editor-platform/factory-core';
import { factoryAutoLayout } from './layout';

/**
 * The factory Surface's state without React (docs/cad/factory-twin.md, FT2). Edits are
 * `factory-core` operations, each one session command applied at once; the Host saves afterwards
 * and owns Undo/Redo. A run never changes the content: its result is kept here with the content
 * key it was computed for, and shows as stale once the model changes.
 */
export type FactorySession = Pick<EditorSession<FactoryDocument>, 'content' | 'execute'>;

/** Runs a model (a Worker in the Playground); rejects with an `Error` whose message is a code. */
export type FactoryRunner = (
  doc: FactoryDocument,
  signal: AbortSignal,
  /** #17: how far a long run has come, between its slices. */
  onProgress?: (p: FactoryRunProgress) => void,
) => Promise<FactoryRunResult>;

/**
 * FT5: runs a model's experiment (a Worker in the Playground), handing over finished runs as they
 * come; resolves when all are done. Stopping aborts `signal` (the Worker is ended).
 */
export type FactoryExperimentRunner = (
  doc: FactoryDocument,
  onRuns: (runs: FactoryExperimentRun[]) => void,
  signal: AbortSignal,
) => Promise<void>;

/** In-thread experiment runner (tests and small models); yields to the page between runs. */
export const factoryLocalExperimentRunner: FactoryExperimentRunner = async (
  doc,
  onRuns,
  signal,
) => {
  for (const run of runFactoryExperiment(doc)) {
    if (signal.aborted) return;
    onRuns([run]);
    await new Promise((r) => setTimeout(r, 0));
  }
};

/** In-thread runner (tests and small models). */
export const factoryLocalRunner: FactoryRunner = async (doc, signal, onProgress) => {
  // #17: in slices, giving the page back between them.
  const run = startFactoryRun(doc, { record: true });
  let p = run.progress();
  while (!p.done) {
    p = run.advance(200_000);
    if (p.done) break;
    onProgress?.(p);
    await new Promise((r) => setTimeout(r, 0));
    if (signal.aborted) throw new Error('stopped');
  }
  return run.finish();
};

export interface FactoryControllerOptions {
  session: FactorySession;
  canEdit(): boolean;
  onApplied?(content: FactoryDocument): void;
  runner?: FactoryRunner;
  experimentRunner?: FactoryExperimentRunner;
}

export interface FactoryNotice {
  code: string;
  path?: string;
  message?: string;
}

export interface FactorySurfaceState {
  content: FactoryDocument;
  key: string;
  /** An object or link ID. */
  selection?: string;
  /** While set, the next object clicked becomes the target of a new link from this one. */
  connectFrom?: string;
  notice?: FactoryNotice;
  readOnly: boolean;
  running: boolean;
  /** #17: how far the run going on has come, and when it started (`performance.now()`). */
  runProgress?: FactoryRunProgress & { startedAt: number };
  /** The last run, and the content key it ran on. */
  result?: { key: string; value: FactoryRunResult };
  /** FT5: an experiment is going on. */
  experimenting: boolean;
  /**
   * FT5: the last experiment's runs so far, the experiment and content key they ran on, the
   * number of runs it has, and whether it ended by itself (not stopped or refused).
   */
  experiment?: {
    key: string;
    experiment: FactoryExperiment;
    runs: FactoryExperimentRun[];
    total: number;
    done: boolean;
  };
}

const key = (doc: FactoryDocument) => canonicalJson(doc);
const sec = (s: number) => ({ type: 'const' as const, value: s * 1000 });

/** A new object of a kind with ordinary starting values. */
export function factoryObjectTemplate(
  doc: FactoryDocument,
  kind: FactoryObjectKind,
  at?: FactoryPlacement,
): FactoryObject {
  const names: Record<FactoryObjectKind, string> = {
    source: 'Source',
    station: 'Station',
    parallel: 'Parallel station',
    assembly: 'Assembly',
    buffer: 'Buffer',
    conveyor: 'Conveyor',
    drain: 'Drain',
  };
  const id = freshFactoryId(doc, kind);
  const base = { id, name: names[kind], ...(at ? { at } : {}) };
  const product = doc.products[0]?.id ?? 'part';
  switch (kind) {
    case 'source':
      return { ...base, kind, interval: sec(60), mix: [{ productId: product, weight: 1 }] };
    case 'station':
      return { ...base, kind, processTime: sec(50) };
    case 'parallel':
      return { ...base, kind, count: 2, processTime: sec(100) };
    case 'assembly': {
      const other = doc.products.find((p) => p.id !== product)?.id ?? product;
      return {
        ...base,
        kind,
        mainProductId: product,
        components: [{ productId: other, count: 1 }],
        processTime: sec(50),
      };
    }
    case 'buffer':
      return { ...base, kind, capacity: 10 };
    case 'conveyor':
      return {
        ...base,
        kind,
        lengthMm: 5000,
        speedMmS: 250,
        partLengthMm: 500,
        accumulating: true,
      };
    case 'drain':
      return { ...base, kind };
  }
}

function noticeOf(error: unknown): FactoryNotice {
  if (error instanceof FactoryValidationError) {
    const d = error.diagnostics[0];
    return { code: error.code, path: d?.path, message: d?.message ?? error.message };
  }
  return { code: error instanceof Error ? error.message : 'failed' };
}

export class FactoryController {
  private current: FactorySurfaceState;
  private readonly listeners = new Set<() => void>();
  private abort?: AbortController;
  private experimentAbort?: AbortController;

  constructor(private readonly options: FactoryControllerOptions) {
    const content = options.session.content;
    this.current = {
      content,
      key: key(content),
      readOnly: !options.canEdit(),
      running: false,
      experimenting: false,
    };
  }
  get state() {
    return this.current;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private set(patch: Partial<FactorySurfaceState>) {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }
  /** Shows a notice for input the Surface could not read; returns its code. */
  notify(notice: FactoryNotice) {
    return this.refuse(notice);
  }
  private refuse(notice: FactoryNotice) {
    this.set({ notice });
    return notice.code;
  }
  /** The result belongs to the content shown now. */
  get fresh() {
    return this.current.result?.key === this.current.key;
  }
  private adopt(content: FactoryDocument) {
    const ids = new Set([...content.objects.map((o) => o.id), ...content.links.map((l) => l.id)]);
    const sel = this.current.selection;
    const from = this.current.connectFrom;
    this.set({
      content,
      key: key(content),
      selection: sel && ids.has(sel) ? sel : undefined,
      connectFrom: from && ids.has(from) ? from : undefined,
    });
  }
  /** After Host Undo/Redo or a restore. */
  sync() {
    const content = this.options.session.content;
    if (key(content) !== this.current.key) this.adopt(content);
  }
  accessChanged() {
    this.set({ readOnly: !this.options.canEdit() });
  }
  /** Applies operations as one command; returns a refusal code or undefined. */
  apply(ops: FactoryOperation | FactoryOperation[]): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    try {
      this.options.session.execute(
        factoryEditorCommand(ops, {
          expectedHash: factoryContentHash(this.options.session.content),
          canEdit: this.options.canEdit,
        }),
      );
    } catch (error) {
      return this.refuse(noticeOf(error));
    }
    const content = this.options.session.content;
    this.adopt(content);
    this.set({ notice: undefined });
    this.options.onApplied?.(content);
    return undefined;
  }
  select(id: string | undefined) {
    const from = this.current.connectFrom;
    if (from && id && id !== from && this.current.content.objects.some((o) => o.id === id)) {
      this.set({ connectFrom: undefined });
      this.connect(from, id);
      return;
    }
    this.set({ selection: id, connectFrom: undefined, notice: undefined });
  }
  /** Starts (or cancels) picking the target of a link from the selected object. */
  toggleConnect() {
    const sel = this.current.selection;
    if (this.current.connectFrom) return void this.set({ connectFrom: undefined });
    if (!sel || !this.current.content.objects.some((o) => o.id === sel))
      return void this.refuse({ code: 'select-object' });
    this.set({ connectFrom: sel, notice: undefined });
  }
  connect(from: string, to: string) {
    const doc = this.current.content;
    const link: FactoryLink = { id: freshFactoryId(doc, `${from}>${to}`), from, to };
    const code = this.apply({ type: 'putLink', link });
    if (!code) this.set({ selection: link.id });
    return code;
  }
  addObject(kind: FactoryObjectKind, at?: FactoryPlacement) {
    const doc = this.current.content;
    const placed = at ?? this.freeSpot();
    const object = factoryObjectTemplate(doc, kind, placed);
    const ops: FactoryOperation[] = [];
    if (kind === 'assembly' && doc.products.length < 2) {
      // An assembly needs a component product besides the main one.
      const id = freshFactoryId(doc, 'component');
      ops.push({ type: 'putProduct', product: { id, name: 'Component' } });
      (object as Extract<FactoryObject, { kind: 'assembly' }>).components = [
        { productId: id, count: 1 },
      ];
    }
    ops.push({ type: 'putObject', object });
    const code = this.apply(ops);
    if (!code) this.set({ selection: object.id });
    return code;
  }
  /** Right of everything placed so far, on the 0 line. */
  private freeSpot(): FactoryPlacement {
    const layout = factoryAutoLayout(this.current.content);
    const xs = [...layout.values()].map((p) => p.x);
    return { x: xs.length ? Math.max(...xs) + 4000 : 0, y: 0 };
  }
  updateObject(object: FactoryObject) {
    return this.apply({ type: 'putObject', object });
  }
  /** Moves an object on the plan (rounded to 100 mm). Lays out the others first if needed. */
  moveObject(id: string, x: number, y: number) {
    const doc = this.current.content;
    const o = doc.objects.find((x) => x.id === id);
    if (!o) return this.refuse({ code: 'not-found' });
    const round = (v: number) => Math.round(v / 100) * 100 + 0;
    const layout = factoryAutoLayout(doc);
    const ops: FactoryOperation[] = doc.objects
      .filter((other) => !other.at && other.id !== id)
      .map((other) => ({ type: 'putObject', object: { ...other, at: layout.get(other.id)! } }));
    ops.push({
      type: 'putObject',
      object: { ...o, at: { ...o.at, x: round(x), y: round(y) } },
    });
    return this.apply(ops);
  }
  updateLink(link: FactoryLink) {
    return this.apply({ type: 'putLink', link });
  }
  deleteSelection() {
    const id = this.current.selection;
    if (!id) return this.refuse({ code: 'select-something' });
    const doc = this.current.content;
    const code = doc.objects.some((o) => o.id === id)
      ? this.apply({ type: 'removeObject', id })
      : this.apply({ type: 'removeLink', id });
    if (!code) this.set({ selection: undefined });
    return code;
  }
  /** A times CSV (see `readFactoryTimesCsv`) as one command. */
  importTimes(text: string) {
    try {
      const ops = readFactoryTimesCsv(this.current.content, text);
      if (!ops.length) return this.refuse({ code: 'csv', message: 'no rows' });
      return this.apply(ops);
    } catch (error) {
      return this.refuse(noticeOf(error));
    }
  }
  /** Runs the current content; the result replaces the last one when it arrives. */
  async run(): Promise<string | undefined> {
    if (this.current.running) return 'running';
    const content = this.current.content;
    const runKey = this.current.key;
    const abort = new AbortController();
    this.abort = abort;
    const startedAt = performance.now();
    this.set({ running: true, notice: undefined, runProgress: undefined });
    try {
      const value = await (this.options.runner ?? factoryLocalRunner)(
        content,
        abort.signal,
        (p) => {
          if (!abort.signal.aborted && this.abort === abort)
            this.set({ runProgress: { ...p, startedAt } });
        },
      );
      if (abort.signal.aborted) return 'stopped';
      this.set({ running: false, runProgress: undefined, result: { key: runKey, value } });
      return undefined;
    } catch (error) {
      if (abort.signal.aborted) return 'stopped';
      this.set({ running: false, runProgress: undefined });
      return this.refuse(noticeOf(error));
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }
  /** FT5: runs the content's experiment; runs show as they finish. */
  async runExperiment(): Promise<string | undefined> {
    if (this.current.experimenting) return 'running';
    const content = this.current.content;
    const experiment = factoryExperimentOf(content);
    const abort = new AbortController();
    this.experimentAbort = abort;
    const runs: FactoryExperimentRun[] = [];
    const show = (done: boolean) =>
      this.set({
        experiment: {
          key: key(content),
          experiment,
          runs: [...runs],
          total: factoryExperimentSize(experiment),
          done,
        },
      });
    this.set({ experimenting: true, notice: undefined });
    show(false);
    try {
      await (this.options.experimentRunner ?? factoryLocalExperimentRunner)(
        content,
        (more) => {
          if (abort.signal.aborted) return;
          runs.push(...more);
          show(false);
        },
        abort.signal,
      );
      if (abort.signal.aborted) return 'stopped';
      this.set({ experimenting: false });
      show(true);
      return undefined;
    } catch (error) {
      if (abort.signal.aborted) return 'stopped';
      this.set({ experimenting: false });
      return this.refuse(noticeOf(error));
    } finally {
      if (this.experimentAbort === abort) this.experimentAbort = undefined;
    }
  }
  /** FT5: stops the experiment; the runs finished so far stay. */
  stopExperiment() {
    if (!this.experimentAbort) return;
    this.experimentAbort.abort();
    this.experimentAbort = undefined;
    this.set({ experimenting: false, notice: { code: 'stopped' } });
  }
  stop() {
    if (!this.abort) return;
    this.abort.abort();
    this.abort = undefined;
    this.set({ running: false, runProgress: undefined, notice: { code: 'stopped' } });
  }
}
