import { canonicalJson } from '@editor-platform/artifact-core';
import { CircuitError, schematicCircuit } from '@editor-platform/circuit-sim-core';
import {
  Cosim,
  CosimError,
  validateCosim,
  type CosimBinding,
  type CosimChange,
  type CosimDocument,
  type CosimFrame,
  type CosimSourceRef,
} from '@editor-platform/cosim-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type EditorSession,
} from '@editor-platform/editor-core';
import {
  ladderInitialState,
  ladderVariableMap,
  validateLadder,
  type LadderDocument,
  type LadderState,
  type LadderValue,
} from '@editor-platform/ladder-core';
import { isSchematicDocument, type SchematicDocument } from '@editor-platform/schematic-core';

/**
 * The co-simulation Surface's state without React (docs/cad/circuit-simulation.md, SL8). The
 * document names one saved version of a schematic and of a ladder program and binds the
 * program's BOOL inputs and outputs to the schematic's nets. Editing it is one session command
 * per change; the Host saves afterwards and owns Undo/Redo. Running never changes the content:
 * switches, typed inputs and the simulation live here, and edits are refused while it runs.
 */
export type CosimSession = Pick<EditorSession<CosimDocument>, 'content' | 'execute'>;

export interface CosimSourceVersion {
  versionId: string;
  label: string;
  contentHash: string;
}
export interface CosimSourceEntry {
  artifactId: string;
  name: string;
  /** Newest first. */
  versions: CosimSourceVersion[];
}
/** Saved versions the Host offers; `document` reads one exact version or throws. */
export interface CosimSource<T> {
  list(): Promise<CosimSourceEntry[]>;
  document(ref: CosimSourceRef): Promise<T>;
}
export interface CosimSources {
  schematics: CosimSource<SchematicDocument>;
  ladders: CosimSource<LadderDocument>;
}

export interface CosimControllerOptions {
  session: CosimSession;
  /** Trusted, current edit authority; re-read by every command. */
  canEdit(): boolean;
  /** After an edit is applied: the Host saves the draft. */
  onApplied?(content: CosimDocument): void;
  sources: CosimSources;
  /** The clock that runs scans (tests pass their own). Default: `setInterval`. */
  every?(ms: number, run: () => void): () => void;
}

export interface CosimNotice {
  code: string;
  path?: string;
  variable?: string;
  net?: string;
}

export interface CosimRunState {
  running: boolean;
  /** The last scan (none before the first). */
  frame?: CosimFrame;
  /** Switch part ID → closed. */
  switches: Record<string, boolean>;
  /** Typed values of unbound inputs. */
  inputs: Record<string, LadderValue>;
}

export interface CosimLoaded {
  schematic?: SchematicDocument;
  ladder?: LadderDocument;
  /** Why a chosen source could not be read (`source-missing`, `source-invalid`, …). */
  errors: { schematic?: string; ladder?: string };
  /** Nets the calculation uses (not ground), or none when the schematic cannot be calculated. */
  nets: string[];
  /** Why the schematic cannot be calculated (a `CircuitError` code). */
  circuitError?: string;
}

export interface CosimSurfaceState {
  content: CosimDocument;
  key: string;
  notice?: CosimNotice;
  readOnly: boolean;
  loaded: CosimLoaded;
  /** True while the sources are being read. */
  loading: boolean;
  run: CosimRunState;
}

const key = (doc: CosimDocument) => canonicalJson(doc);
const dict = <T>() => Object.create(null) as Record<string, T>;

export class CosimEditError extends Error {
  constructor(
    readonly code: string,
    readonly path?: string,
  ) {
    super(code);
  }
}

/** One ordinary EditorSession transaction replacing the document; re-checks base and authority. */
export function cosimEditorCommand(
  label: string,
  next: CosimDocument,
  options: { expectedKey: string; canEdit(): boolean },
): EditorCommand<CosimDocument> {
  const prepared = structuredClone(next);
  const run = (content: CosimDocument) => {
    if (!options.canEdit()) throw new CosimEditError('permission-denied');
    if (key(content) !== options.expectedKey) throw new CosimEditError('cosim-base-mismatch');
    const d = validateCosim(prepared)[0];
    if (d) throw new CosimEditError(d.code, d.path);
    return structuredClone(prepared);
  };
  return withCommandReads(immutableCommand('cosim.edit', label, run), { content: ['*'] });
}

/** The switch parts of a schematic (part ID and reference). */
export function cosimSwitches(doc: SchematicDocument | undefined) {
  return (doc?.parts ?? [])
    .filter((p) => p.model?.kind === 'switch')
    .map((p) => ({ id: p.id, ref: p.ref }));
}

/** The program's BOOL variables a binding of `kind` can name. */
export function cosimVariables(doc: LadderDocument | undefined, kind: CosimBinding['kind']) {
  return (doc?.variables ?? [])
    .filter((v) => v.type === 'BOOL' && v.role === kind)
    .map((v) => v.name);
}

const freshRun = (): CosimRunState => ({ running: false, switches: dict(), inputs: dict() });
const emptyLoaded = (): CosimLoaded => ({ errors: {}, nets: [] });

export class CosimController {
  private current: CosimSurfaceState;
  private readonly listeners = new Set<() => void>();
  private stopClock?: () => void;
  private sim?: Cosim;
  /** Changes waiting for a scan, one per scan, so a press and its release both reach the circuit. */
  private queue: CosimChange[] = [];
  private loads = 0;

  constructor(private readonly options: CosimControllerOptions) {
    const content = options.session.content;
    this.current = {
      content,
      key: key(content),
      readOnly: !options.canEdit(),
      loaded: emptyLoaded(),
      loading: false,
      run: freshRun(),
    };
  }

  get state(): CosimSurfaceState {
    return this.current;
  }
  get sources(): CosimSources {
    return this.options.sources;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private set(patch: Partial<CosimSurfaceState>) {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }
  private refuse(notice: CosimNotice) {
    this.set({ notice });
    return notice.code;
  }
  dismissNotice() {
    this.set({ notice: undefined });
  }
  accessChanged() {
    this.set({ readOnly: !this.options.canEdit() });
  }

  /**
   * Reads the chosen versions (again). A newer call wins over one still reading. Resolves when
   * the state shows them.
   */
  async load(): Promise<void> {
    const ticket = ++this.loads;
    const doc = this.current.content;
    // The versions shown until now may no longer be the chosen ones: nothing runs until the
    // chosen ones are read.
    this.reset();
    this.set({ loading: true, loaded: emptyLoaded() });
    const loaded = emptyLoaded();
    const read = async <T>(
      ref: CosimSourceRef | undefined,
      source: CosimSource<T>,
      valid: (x: unknown) => boolean,
    ): Promise<T | string | undefined> => {
      if (!ref) return undefined;
      try {
        const got = await source.document(ref);
        return valid(got) ? got : 'source-invalid';
      } catch (error) {
        return error instanceof Error && error.message ? error.message : 'source-missing';
      }
    };
    const [schematic, ladder] = await Promise.all([
      read(doc.schematic, this.options.sources.schematics, isSchematicDocument),
      read(
        doc.ladder,
        this.options.sources.ladders,
        (x) => !validateLadder(x).some((d) => d.severity === 'error'),
      ),
    ]);
    if (ticket !== this.loads) return;
    if (typeof schematic === 'string') loaded.errors.schematic = schematic;
    else if (schematic) {
      loaded.schematic = schematic;
      try {
        loaded.nets = schematicCircuit(schematic).nodes.slice(1);
      } catch (error) {
        loaded.circuitError = error instanceof CircuitError ? error.code : 'circuit-failed';
      }
    }
    if (typeof ladder === 'string') loaded.errors.ladder = ladder;
    else if (ladder) loaded.ladder = ladder;
    this.reset();
    this.set({ loaded, loading: false });
  }

  // Editing.

  private edit(label: string, next: CosimDocument): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied' });
    if (this.current.run.running) return this.refuse({ code: 'running' });
    let content: CosimDocument;
    try {
      content = this.options.session.execute(
        cosimEditorCommand(label, next, {
          expectedKey: this.current.key,
          canEdit: () => this.options.canEdit(),
        }),
      );
    } catch (error) {
      return this.refuse(
        error instanceof CosimEditError
          ? { code: error.code, path: error.path }
          : { code: error instanceof Error ? error.message : 'failed' },
      );
    }
    const sourcesChanged =
      key({ ...content, bindings: [], name: '' }) !==
      key({ ...this.current.content, bindings: [], name: '' });
    this.reset();
    this.set({ content, key: key(content), notice: undefined });
    this.options.onApplied?.(content);
    if (sourcesChanged) void this.load();
    return undefined;
  }
  /** Host Undo, Redo or restore changed the session: show its content. */
  sync() {
    const content = this.options.session.content;
    if (key(content) === this.current.key) return;
    this.reset();
    this.set({ content, key: key(content) });
    void this.load();
  }
  setName(name: string) {
    return this.edit('Rename', { ...this.current.content, name });
  }
  /** Chooses a version of a schematic or ladder program (undefined: none). */
  setSource(kind: 'schematic' | 'ladder', ref: CosimSourceRef | undefined) {
    const { [kind]: _, ...rest } = this.current.content;
    return this.edit(
      kind === 'schematic' ? 'Choose schematic' : 'Choose ladder program',
      ref ? { ...rest, [kind]: { ...ref } } : rest,
    );
  }
  /** Binds the first free variable of `kind` to the first free net. */
  addBinding(kind: CosimBinding['kind']) {
    const doc = this.current.content;
    const usedVars = new Set(doc.bindings.map((b) => b.variable.toUpperCase()));
    const usedNets = new Set(doc.bindings.map((b) => b.net));
    const variable = cosimVariables(this.current.loaded.ladder, kind).find(
      (v) => !usedVars.has(v.toUpperCase()),
    );
    if (!variable) return this.refuse({ code: 'no-free-variable' });
    const net = this.current.loaded.nets.find((n) => !usedNets.has(n));
    if (!net) return this.refuse({ code: 'no-free-net' });
    const binding: CosimBinding =
      kind === 'input' ? { variable, net, kind, pull: 'up' } : { variable, net, kind };
    return this.edit('Add binding', { ...doc, bindings: [...doc.bindings, binding] });
  }
  updateBinding(index: number, binding: CosimBinding) {
    const doc = this.current.content;
    if (!doc.bindings[index]) return this.refuse({ code: 'not-found' });
    const clean: CosimBinding = {
      variable: binding.variable,
      net: binding.net,
      kind: binding.kind,
    };
    if (binding.kind === 'input') clean.pull = binding.pull ?? 'up';
    if (binding.activeLow) clean.activeLow = true;
    return this.edit('Edit binding', {
      ...doc,
      bindings: doc.bindings.map((b, i) => (i === index ? clean : b)),
    });
  }
  deleteBinding(index: number) {
    const doc = this.current.content;
    if (!doc.bindings[index]) return this.refuse({ code: 'not-found' });
    return this.edit('Delete binding', {
      ...doc,
      bindings: doc.bindings.filter((_, i) => i !== index),
    });
  }

  // Running.

  /** The program's state to show: the last scan's, or its initial values. */
  ladderState(): LadderState | undefined {
    const l = this.current.loaded.ladder;
    return this.current.run.frame?.ladder ?? (l ? ladderInitialState(l) : undefined);
  }
  private make(): Cosim | string {
    if (this.sim) return this.sim;
    if (this.current.loading) return this.refuse({ code: 'loading' });
    const { schematic, ladder } = this.current.loaded;
    if (!schematic || !ladder) return this.refuse({ code: 'sources-missing' });
    try {
      this.sim = new Cosim(schematic, ladder, this.current.content.bindings, {
        ...this.current.run.switches,
      });
    } catch (error) {
      if (error instanceof CosimError) return this.refuse({ code: error.code, ...error.detail });
      if (error instanceof CircuitError) return this.refuse({ code: error.code });
      throw error;
    }
    return this.sim;
  }
  /** One scan with the next queued change. Returns the refusal's code, if any. */
  step(): string | undefined {
    const sim = this.make();
    if (typeof sim === 'string') {
      this.stop();
      return sim;
    }
    let frame: CosimFrame;
    try {
      frame = sim.scan(this.queue.shift() ?? {});
    } catch (error) {
      this.stop();
      return this.refuse({
        code: error instanceof CircuitError || error instanceof CosimError ? error.code : 'failed',
      });
    }
    this.set({ run: { ...this.current.run, frame }, notice: undefined });
    return undefined;
  }
  start(): string | undefined {
    if (this.current.run.running) return undefined;
    const refused = this.step();
    if (refused) return refused;
    const every =
      this.options.every ??
      ((ms: number, run: () => void) => {
        const t = setInterval(run, ms);
        return () => clearInterval(t);
      });
    this.stopClock = every(this.current.loaded.ladder!.scanMs, () => {
      if (this.step()) this.stop();
    });
    this.set({ run: { ...this.current.run, running: true } });
    return undefined;
  }
  stop() {
    this.stopClock?.();
    this.stopClock = undefined;
    if (this.current.run.running) this.set({ run: { ...this.current.run, running: false } });
  }
  /** Back to time 0: switches open, typed inputs cleared. */
  reset() {
    this.stop();
    this.sim = undefined;
    this.queue = [];
    this.set({ run: freshRun() });
  }
  /** Closes or opens a switch (from the next scan on). */
  press(id: string, closed: boolean) {
    if (!cosimSwitches(this.current.loaded.schematic).some((s) => s.id === id))
      return this.refuse({ code: 'not-found' });
    this.queue.push({ switches: { [id]: closed } });
    this.set({
      run: { ...this.current.run, switches: { ...this.current.run.switches, [id]: closed } },
    });
    return undefined;
  }
  /** Sets an input the circuit does not drive (from the next scan on). */
  setInput(name: string, value: boolean) {
    const ladder = this.current.loaded.ladder;
    const v = ladder && ladderVariableMap(ladder).get(name);
    const bound = new Set(this.current.content.bindings.map((b) => b.variable.toUpperCase()));
    if (!v || v.role !== 'input' || v.type !== 'BOOL' || bound.has(v.name.toUpperCase()))
      return this.refuse({ code: 'input-value', variable: name });
    this.queue.push({ inputs: { [v.name]: value } });
    this.set({
      run: { ...this.current.run, inputs: { ...this.current.run.inputs, [v.name]: value } },
    });
    return undefined;
  }
}
