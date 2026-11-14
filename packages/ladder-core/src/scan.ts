import type { LadderDocument, LadderNode, LadderOperand, LadderVariable } from './model';
import { ladderVariableMap } from './validate';

/**
 * The scan (docs/cad/circuit-simulation.md, SL6): copy the inputs in, evaluate the rungs from the
 * top with IEC 61131-3 LD semantics (power flows from the left rail; a later rung sees an earlier
 * rung's coils within the same scan), and leave the outputs for the caller to copy out. Time is
 * virtual: each scan advances the timers by the program's `scanMs`, never by the wall clock, so a
 * run is reproducible.
 */

export type LadderValue = boolean | number;

/** A timer instance (IEC TON/TOF/TP): input last scan, elapsed time, output. */
export interface LadderTimerState {
  in: boolean;
  et: number;
  q: boolean;
}
/** A counter instance (IEC CTU/CTD): count input last scan, current value, output. */
export interface LadderCounterState {
  cu: boolean;
  cv: number;
  q: boolean;
}

export interface LadderState {
  /** Variable name (as declared) → value. Blocks are in `blocks`. */
  values: Record<string, LadderValue>;
  blocks: Record<string, LadderTimerState | LadderCounterState>;
  /** Edge contact node ID → its variable's value when it was last evaluated. */
  edges: Record<string, boolean>;
  /** Scans run, and the virtual time (ms) they make. */
  scans: number;
  timeMs: number;
}

export interface LadderScanResult {
  state: LadderState;
  /** Node and coil ID → whether power leaves it (for drawing the powered parts). */
  power: Record<string, boolean>;
}

const dict = <T>() => Object.create(null) as Record<string, T>;

/** Every variable at its initial value (false, 0), every block reset. */
export function ladderInitialState(doc: LadderDocument): LadderState {
  const values = dict<LadderValue>();
  const blocks = dict<LadderTimerState | LadderCounterState>();
  for (const v of doc.variables) {
    if (v.type === 'BOOL') values[v.name] = v.initial === true;
    else if (v.type === 'INT' || v.type === 'TIME') values[v.name] = (v.initial as number) ?? 0;
    else if (v.type === 'CTU' || v.type === 'CTD') blocks[v.name] = { cu: false, cv: 0, q: false };
    else blocks[v.name] = { in: false, et: 0, q: false };
  }
  return { values, blocks, edges: dict(), scans: 0, timeMs: 0 };
}

/**
 * One scan. `inputs` (input variables by name) are copied in first; `forced` values (any BOOL,
 * INT or TIME variable) override both the inputs and the coils for this scan. The program is
 * expected to be valid (`validateLadder`). Returns a new state; the given one is not changed.
 */
export function ladderScan(
  doc: LadderDocument,
  previous: LadderState,
  inputs: Readonly<Record<string, LadderValue>> = {},
  forced: Readonly<Record<string, LadderValue>> = {},
): LadderScanResult {
  const vars = ladderVariableMap(doc);
  const state: LadderState = {
    values: Object.assign(dict<LadderValue>(), previous.values),
    blocks: dict(),
    edges: Object.assign(dict<boolean>(), previous.edges),
    scans: previous.scans + 1,
    timeMs: previous.timeMs + doc.scanMs,
  };
  for (const [k, b] of Object.entries(previous.blocks)) state.blocks[k] = { ...b };
  const decl = (name: string): LadderVariable | undefined => vars.get(name);
  const own = (o: Readonly<Record<string, LadderValue>>, name: string) => {
    for (const k of Object.keys(o)) if (k.toUpperCase() === name.toUpperCase()) return o[k];
    return undefined;
  };
  // Inputs, then forcing.
  for (const v of doc.variables) {
    if (v.role === 'input') {
      const x = own(inputs, v.name);
      if (x !== undefined) state.values[v.name] = v.type === 'BOOL' ? !!x : Number(x);
    }
  }
  const forcedOf = (v: LadderVariable) => own(forced, v.name);
  for (const v of doc.variables) {
    const f = forcedOf(v);
    if (f !== undefined && Object.hasOwn(state.values, v.name)) state.values[v.name] = f;
  }
  const read = (name: string) => {
    const v = decl(name);
    return v ? state.values[v.name] : undefined;
  };
  const write = (name: string, value: boolean) => {
    const v = decl(name);
    if (!v || forcedOf(v) !== undefined) return;
    state.values[v.name] = value;
  };
  const operand = (o: LadderOperand): number => {
    if ('value' in o) return o.value;
    const v = decl(o.variable);
    if (!v) return 0;
    if (o.member === 'CV') return (state.blocks[v.name] as LadderCounterState).cv;
    if (o.member === 'ET') return (state.blocks[v.name] as LadderTimerState).et;
    return Number(state.values[v.name]);
  };
  const power = dict<boolean>();
  const dt = doc.scanMs;

  const run = (n: LadderNode, pin: boolean): boolean => {
    let out: boolean;
    switch (n.kind) {
      case 'contact': {
        const x = read(n.variable) === true;
        let ok: boolean;
        if (n.contact === 'no') ok = x;
        else if (n.contact === 'nc') ok = !x;
        else {
          // An edge contact compares with its own last evaluation (IEC P / N contacts); before
          // its first evaluation, with the variable's value before this scan's inputs, so a
          // change on the first scan is an edge.
          const before = decl(n.variable);
          const was = state.edges[n.id] ?? (before ? previous.values[before.name] === true : x);
          ok = n.contact === 'rising' ? x && !was : !x && was;
          state.edges[n.id] = x;
        }
        out = pin && ok;
        break;
      }
      case 'series':
        out = pin;
        for (const c of n.items) out = run(c, out);
        break;
      case 'parallel':
        out = false;
        // Every branch is evaluated (its blocks and edges update) even when one already passes.
        for (const b of n.branches) out = run(b, pin) || out;
        break;
      case 'timer': {
        const v = decl(n.instance)!;
        const t = state.blocks[v.name] as LadderTimerState;
        const pt = n.presetMs;
        if (v.type === 'TON') {
          t.et = pin ? Math.min(pt, t.et + (t.in ? dt : 0)) : 0;
          t.q = pin && t.et >= pt;
        } else if (v.type === 'TOF') {
          if (pin) {
            t.et = 0;
            t.q = true;
          } else if (t.q) {
            // Timing starts at the scan IN falls.
            t.et = t.in ? 0 : Math.min(pt, t.et + dt);
            if (t.et >= pt) t.q = false;
          }
        } else {
          // TP: a pulse of PT from a rising IN, not retriggered while it runs; ET holds at PT
          // until IN falls.
          if (t.q) {
            t.et = Math.min(pt, t.et + dt);
            if (t.et >= pt) t.q = false;
          } else if (pin && !t.in) {
            t.et = 0;
            t.q = pt > 0;
          }
          if (!t.q && !pin) t.et = 0;
        }
        t.in = pin;
        out = t.q;
        break;
      }
      case 'counter': {
        const v = decl(n.instance)!;
        const c = state.blocks[v.name] as LadderCounterState;
        const r = n.reset !== undefined && read(n.reset) === true;
        const rise = pin && !c.cu;
        if (v.type === 'CTU') {
          if (r) c.cv = 0;
          else if (rise && c.cv < 32767) c.cv = c.cv + 1;
          c.q = c.cv >= n.preset;
        } else {
          if (r) c.cv = n.preset;
          // IEC CTD counts down only while CV > 0 (CTU only below the INT maximum).
          else if (rise && c.cv > 0) c.cv = c.cv - 1;
          c.q = c.cv <= 0;
        }
        c.cu = pin;
        out = c.q;
        break;
      }
      case 'compare': {
        const a = operand(n.a);
        const b = operand(n.b);
        const ok =
          n.op === 'eq'
            ? a === b
            : n.op === 'ne'
              ? a !== b
              : n.op === 'gt'
                ? a > b
                : n.op === 'ge'
                  ? a >= b
                  : n.op === 'lt'
                    ? a < b
                    : a <= b;
        out = pin && ok;
        break;
      }
    }
    power[n.id] = out;
    return out;
  };

  for (const rung of doc.rungs) {
    const p = run(rung.network, true);
    for (const c of rung.coils) {
      power[c.id] = p;
      if (c.coil === 'normal') write(c.variable, p);
      else if (c.coil === 'negated') write(c.variable, !p);
      else if (p) write(c.variable, c.coil === 'set');
    }
  }
  return { state, power };
}

/** The output variables' values. */
export function ladderOutputs(
  doc: LadderDocument,
  state: LadderState,
): Record<string, LadderValue> {
  const out = dict<LadderValue>();
  for (const v of doc.variables) if (v.role === 'output') out[v.name] = state.values[v.name];
  return out;
}

/** `count` scans with the same inputs; the states after each. */
export function ladderRun(
  doc: LadderDocument,
  state: LadderState,
  count: number,
  inputs: Readonly<Record<string, LadderValue>> = {},
): LadderState[] {
  const out: LadderState[] = [];
  let s = state;
  for (let i = 0; i < count; i++) out.push((s = ladderScan(doc, s, inputs).state));
  return out;
}
