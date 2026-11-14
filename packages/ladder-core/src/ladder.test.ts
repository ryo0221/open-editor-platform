import { describe, expect, it } from 'vitest';
import {
  ladderBlinkExample,
  ladderCounterExample,
  ladderInitialState,
  ladderOutputs,
  ladderScan,
  ladderSelfHoldExample,
  validateLadder,
  type LadderDocument,
  type LadderNode,
  type LadderState,
} from './index';

const codes = (doc: unknown) =>
  validateLadder(doc).map((d) => `${d.severity[0]} ${d.code} ${d.id ?? d.path}`);
/** Scans with `inputs`, `n` times; the last state. */
const scan = (
  doc: LadderDocument,
  s: LadderState,
  n: number,
  inputs: Record<string, boolean> = {},
) => {
  for (let i = 0; i < n; i++) s = ladderScan(doc, s, inputs).state;
  return s;
};
const one = (network: LadderNode, variables: LadderDocument['variables'] = []): LadderDocument => ({
  schemaVersion: 1,
  name: 't',
  scanMs: 10,
  variables: [
    { name: 'A', type: 'BOOL', role: 'input' },
    { name: 'Q', type: 'BOOL', role: 'output' },
    ...variables,
  ],
  rungs: [{ id: 'r', network, coils: [{ id: 'c', variable: 'Q', coil: 'normal' }] }],
});

// TS-2110: the ladder program, its checks and the scan.
describe('ladder-core (TS-2110)', () => {
  it('accepts the examples and refuses bad programs by code', () => {
    for (const f of [ladderSelfHoldExample, ladderBlinkExample, ladderCounterExample])
      expect(codes(f())).toEqual([]);
    const doc = ladderSelfHoldExample() as unknown as Record<string, unknown> & LadderDocument;
    doc.variables.push(
      { name: 'start', type: 'BOOL', role: 'internal' },
      { name: '9X', type: 'BOOL', role: 'internal' },
      { name: 'AND', type: 'BOOL', role: 'internal' },
      { name: 'T1', type: 'TON', role: 'input' },
    );
    doc.rungs.push({
      id: 'r2',
      network: {
        id: 'n1',
        kind: 'parallel',
        branches: [{ id: 'x1', kind: 'contact', variable: 'NOPE', contact: 'no' }],
      },
      coils: [
        { id: 'c2', variable: 'STOP', coil: 'normal' },
        { id: 'c3', variable: 'LAMP', coil: 'normal' },
      ],
    });
    expect(codes(doc)).toEqual([
      'e name-duplicate start',
      'e name-invalid 9X',
      'e name-invalid AND',
      'e variable-role T1',
      'e id-duplicate n1',
      'e branch-count n1',
      'e variable-missing x1',
      'e coil-input c2',
      'w coil-duplicate c3',
    ]);
    expect(codes({ ...ladderSelfHoldExample(), scanMs: 0 })).toEqual(['e scan-ms $.scanMs']);
    expect(codes({ ...ladderSelfHoldExample(), extra: 1 })).toEqual(['e shape $.extra']);
  });

  it('holds a lamp on after START and drops it with STOP', () => {
    const doc = ladderSelfHoldExample();
    let s = ladderInitialState(doc);
    s = scan(doc, s, 1, { START: true });
    expect(ladderOutputs(doc, s)).toEqual({ LAMP: true });
    s = scan(doc, s, 5, { START: false });
    expect(s.values.LAMP).toBe(true);
    const r = ladderScan(doc, s, { STOP: true });
    expect(r.state.values.LAMP).toBe(false);
    // Power per node: START off, LAMP's own contact on, STOP's NC contact broken.
    expect(r.power).toMatchObject({ n3: false, n4: true, n2: true, n5: false, c1: false });
    expect(scan(doc, r.state, 3, { STOP: false }).values.LAMP).toBe(false);
    // Forcing overrides the coil.
    expect(ladderScan(doc, ladderInitialState(doc), {}, { LAMP: true }).state.values.LAMP).toBe(
      true,
    );
  });

  it('blinks 500 ms on, 500 ms off in virtual time', () => {
    const doc = ladderBlinkExample();
    let s = ladderInitialState(doc);
    const lamp: boolean[] = [];
    for (let i = 0; i < 300; i++) {
      s = ladderScan(doc, s, { ENABLE: true }).state;
      lamp.push(s.values.LAMP as boolean);
    }
    expect(s.timeMs).toBe(3000);
    // Lengths of the runs of equal values, in scans of 10 ms.
    const runs: number[] = [];
    lamp.forEach((v, i) => (i && v === lamp[i - 1] ? runs[runs.length - 1]++ : runs.push(1)));
    expect(lamp[0]).toBe(true);
    for (const n of runs.slice(0, -1)) expect(Math.abs(n - 50)).toBeLessThanOrEqual(1);
    expect(scan(doc, s, 1, { ENABLE: false }).values.LAMP).toBe(false);
  });

  it('counts rising edges, compares the count and resets', () => {
    const doc = ladderCounterExample();
    let s = ladderInitialState(doc);
    const pulse = () => (s = scan(doc, scan(doc, s, 2, { PULSE: true }), 2, { PULSE: false }));
    pulse();
    expect(s.blocks.COUNT).toMatchObject({ cv: 1, q: false });
    expect(s.values.HALF).toBe(false);
    pulse();
    expect(s.values.HALF).toBe(true);
    pulse();
    expect(s.values.DONE).toBe(true);
    s = scan(doc, s, 1, { RESET: true });
    expect(s.blocks.COUNT).toMatchObject({ cv: 0, q: false });
    expect(s.values.DONE).toBe(false);
    // A CTD loaded with 1 stops at 0: 1 → 0 → 0.
    const down: LadderDocument = {
      ...doc,
      variables: doc.variables.map((v) =>
        v.name === 'COUNT' ? { ...v, type: 'CTD' as const } : v,
      ),
      rungs: [
        {
          ...doc.rungs[0],
          network: {
            id: 'n1',
            kind: 'series',
            items: [
              { id: 'n2', kind: 'contact', variable: 'PULSE', contact: 'no' },
              { id: 'n3', kind: 'counter', instance: 'COUNT', preset: 1, reset: 'RESET' },
            ],
          },
        },
      ],
    };
    let d = scan(down, ladderInitialState(down), 1, { RESET: true });
    d = scan(down, d, 1, { RESET: false });
    expect(d.blocks.COUNT).toMatchObject({ cv: 1, q: false });
    const press = () => (d = scan(down, scan(down, d, 1, { PULSE: true }), 1, { PULSE: false }));
    press();
    expect(d.blocks.COUNT).toMatchObject({ cv: 0, q: true });
    press();
    expect(d.blocks.COUNT).toMatchObject({ cv: 0, q: true });
  });

  it('times TOF and TP, and edge contacts pass one scan', () => {
    const tof = one({ id: 't', kind: 'timer', instance: 'T', presetMs: 50 }, [
      { name: 'T', type: 'TOF', role: 'internal' },
    ]);
    const net = (doc: LadderDocument) => ({
      ...doc,
      rungs: [
        {
          ...doc.rungs[0],
          network: {
            id: 's',
            kind: 'series' as const,
            items: [
              { id: 'a', kind: 'contact' as const, variable: 'A', contact: 'no' as const },
              doc.rungs[0].network,
            ],
          },
        },
      ],
    });
    const d1 = net(tof);
    let s = scan(d1, ladderInitialState(d1), 3, { A: true });
    expect(s.values.Q).toBe(true);
    // Off-delay: still on until 50 ms after the scan A falls in, then off.
    s = scan(d1, s, 5, { A: false });
    expect(s.values.Q).toBe(true);
    s = scan(d1, s, 1, { A: false });
    expect(s.values.Q).toBe(false);
    const tp = net(
      one({ id: 't', kind: 'timer', instance: 'T', presetMs: 30 }, [
        { name: 'T', type: 'TP', role: 'internal' },
      ]),
    );
    const q: boolean[] = [];
    let p = ladderInitialState(tp);
    for (let i = 0; i < 8; i++)
      q.push((p = ladderScan(tp, p, { A: true }).state).values.Q as boolean);
    expect(q).toEqual([true, true, true, false, false, false, false, false]);
    const edge = one({ id: 'e', kind: 'contact', variable: 'A', contact: 'rising' });
    const e: boolean[] = [];
    let x = ladderInitialState(edge);
    for (const a of [false, true, true, false, true])
      e.push((x = ladderScan(edge, x, { A: a }).state).values.Q as boolean);
    expect(e).toEqual([false, true, false, false, true]);
    // A change on the very first scan is an edge too (rising from the initial FALSE, falling
    // from an initial TRUE).
    x = ladderInitialState(edge);
    expect(ladderScan(edge, x, { A: true }).state.values.Q).toBe(true);
    const fall = one({ id: 'e', kind: 'contact', variable: 'A', contact: 'falling' });
    fall.variables[0].initial = true;
    expect(ladderScan(fall, ladderInitialState(fall), { A: false }).state.values.Q).toBe(true);
    expect(ladderScan(fall, ladderInitialState(fall), { A: true }).state.values.Q).toBe(false);
  });
});
