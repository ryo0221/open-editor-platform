import { describe, expect, it } from 'vitest';
import type { LadderDocument, LadderVariable } from '@editor-platform/ladder-core';
import {
  f174PlcLine,
  f175PlcLineBug,
  newFactory,
  runFactory,
  type FactoryControl,
  type FactoryDocument,
  type FactoryRunResult,
} from './index';

const c = (ms: number) => ({ type: 'const' as const, value: ms });
const state = (r: FactoryRunResult, id: string, s: string) =>
  r.objects.find((o) => o.id === id)!.states[s as 'held'];

/** A program of BOOL variables with one rung per coil: `coil := contact` (or the rail). */
function program(
  variables: [string, LadderVariable['role'], boolean?][],
  rungs: { coil: string; contact?: string; nc?: boolean }[] = [],
  scanMs = 100,
): LadderDocument {
  return {
    schemaVersion: 1,
    name: 'Test',
    scanMs,
    variables: variables.map(([name, role, initial]) => ({
      name,
      type: 'BOOL',
      role,
      ...(initial !== undefined ? { initial } : {}),
    })),
    rungs: rungs.map((r, i) => ({
      id: `r${i}`,
      network: r.contact
        ? { id: `n${i}`, kind: 'contact', variable: r.contact, contact: r.nc ? 'nc' : 'no' }
        : { id: `n${i}`, kind: 'series', items: [] },
      coils: [{ id: `c${i}`, variable: r.coil, coil: 'normal' }],
    })),
  };
}

/** Source (every `everyMs`) → station `st` (`processMs`) → drain, with `control`. */
function line(control: FactoryControl, everyMs = 10_000, processMs = 1000): FactoryDocument {
  const doc = newFactory('Controlled');
  doc.objects = [
    {
      id: 'in',
      name: 'In',
      kind: 'source',
      interval: c(everyMs),
      mix: [{ productId: 'part', weight: 1 }],
    },
    { id: 'st', name: 'Station', kind: 'station', processTime: c(processMs) },
    { id: 'out', name: 'Out', kind: 'drain' },
  ];
  doc.links = [
    { id: 'l1', from: 'in', to: 'st' },
    { id: 'l2', from: 'st', to: 'out' },
  ];
  doc.control = control;
  doc.run = { durationMs: 60_000, seed: 1 };
  return doc;
}

describe('FT6 PLC control of the flow (TS-2685)', () => {
  it('runs F174 with the PLC: the same output as without it, the conveyor held while the inspection is busy', () => {
    const doc = f174PlcLine();
    const r = runFactory(doc, { record: true });
    const free = structuredClone(doc);
    delete free.control;
    const plain = runFactory(free);
    expect(r.produced).toBe(718);
    expect(plain.produced).toBe(718);
    expect(r.control!.scans).toBe(288_001);
    expect(r.control!.stalls).toEqual([]);
    expect(state(r, 'c1', 'held')).toBeGreaterThan(0);
    expect(state(plain, 'c1', 'held')).toBe(0);
    expect(plain.control).toBeUndefined();
    expect(plain.timeline).toBeUndefined();
    // Every wired signal is recorded at the first scan, and then only when it changes.
    const sig = r.timeline!.signals;
    expect(sig.slice(0, 16)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0]);
    for (let i = 0; i < sig.length; i += 4) expect(sig[i]! % 100).toBe(0);
    // Deterministic, and the timeline does not change the statistics.
    const again = runFactory(doc);
    expect(again.produced).toBe(r.produced);
    expect(again.objects).toEqual(r.objects);
    expect(again.control!.state).toEqual(r.control!.state);
  });

  it('shows the ladder bug of F175 as a stopped flow, with the held conveyor and since when', () => {
    const r = runFactory(f175PlcLineBug());
    expect(r.produced).toBeLessThanOrEqual(2);
    expect(r.control!.stalls).toEqual([{ objectId: 'c1', signal: 'run', sinceMs: 130_000 }]);
    expect(r.control!.lastMoveMs).toBeLessThan(200_000);
    expect(r.control!.state.values.C1_HOLD).toBe(true);
    expect(r.control!.power.r3c).toBe(false);
    expect(state(r, 'c1', 'held') / (r.endMs - r.startMs)).toBeGreaterThan(0.99);
    // A shorter run than `stallMs` after the stop does not report it.
    const short = f175PlcLineBug();
    short.control!.stallMs = 3_600_000;
    short.run.durationMs = 3_600_000;
    expect(runFactory(short).control!.stalls).toEqual([]);
  });

  it('syncs the scan with the event time: a gate opens only at the next scan', () => {
    // The station's release follows its `ready` sensor, scanned every 300 ms: a part done at
    // t leaves at the first scan at or after t (a scan at t comes after t's events).
    const doc = line({
      program: program(
        [
          ['DONE', 'input'],
          ['GO', 'output'],
        ],
        [{ coil: 'GO', contact: 'DONE' }],
        300,
      ),
      sensors: [{ id: 's1', objectId: 'st', signal: 'ready', variable: 'DONE' }],
      actuators: [{ id: 'a1', objectId: 'st', signal: 'release', variable: 'GO' }],
    });
    const r = runFactory(doc, { record: true });
    const leave = (t: number) => Math.ceil((t + 1000) / 300) * 300 - t;
    const expected = [0, 10, 20, 30, 40, 50].map((s) => leave(s * 1000));
    expect(r.produced).toBe(6);
    expect(r.leadTime.minMs).toBe(Math.min(...expected));
    expect(r.leadTime.maxMs).toBe(Math.max(...expected));
    expect(r.leadTime.meanMs).toBeCloseTo(expected.reduce((a, b) => a + b) / 6, 6);
    expect(state(r, 'st', 'held')).toBe(expected.reduce((a, b) => a + b) - 6 * 1000);
    expect(r.control!.scans).toBe(201);
    // Moves out of the station happen only at scan times.
    const moves = r.timeline!.moves;
    for (let i = 0; i < moves.length; i += 5)
      if (moves[i + 3] === 1) expect(moves[i]! % 300).toBe(0);
  });

  it('stands a conveyor while its motor is off, accumulating or not', () => {
    for (const accumulating of [true, false]) {
      const doc = newFactory('Belt');
      doc.objects = [
        {
          id: 'in',
          name: 'In',
          kind: 'source',
          interval: c(60_000),
          mix: [{ productId: 'part', weight: 1 }],
        },
        {
          id: 'belt',
          name: 'Belt',
          kind: 'conveyor',
          lengthMm: 1000,
          speedMmS: 1000,
          partLengthMm: 500,
          accumulating,
        },
        { id: 'out', name: 'Out', kind: 'drain' },
      ];
      doc.links = [
        { id: 'l1', from: 'in', to: 'belt' },
        { id: 'l2', from: 'belt', to: 'out' },
      ];
      // The motor runs while START, and START is the rail from the scan at 400 ms on: an
      // on-delay timer of 400 ms on the rail.
      doc.control = {
        program: {
          schemaVersion: 1,
          name: 'Delay',
          scanMs: 100,
          variables: [
            { name: 'T1', type: 'TON', role: 'internal' },
            { name: 'RUN', type: 'BOOL', role: 'output' },
          ],
          rungs: [
            {
              id: 'r1',
              network: { id: 'n1', kind: 'timer', instance: 'T1', presetMs: 400 },
              coils: [{ id: 'c1', variable: 'RUN', coil: 'normal' }],
            },
          ],
        },
        sensors: [],
        actuators: [{ id: 'a1', objectId: 'belt', signal: 'run', variable: 'RUN' }],
      };
      doc.run = { durationMs: 10_000, seed: 1 };
      const r = runFactory(doc);
      expect(r.produced).toBe(1);
      // TON: ET counts from the second scan, so Q is on at the scan at 400 ms; then 1 s of belt.
      expect(r.leadTime.meanMs).toBe(1400);
      expect(state(r, 'belt', 'held')).toBe(400);
    }
  });

  it('blocks the feeders of an object whose admit is off, and reports it as a stall', () => {
    const doc = line({
      program: program([['OPEN', 'output', false]]),
      sensors: [],
      actuators: [{ id: 'a1', objectId: 'out', signal: 'admit', variable: 'OPEN' }],
      stallMs: 10_000,
    });
    const r = runFactory(doc);
    expect(r.produced).toBe(0);
    expect(r.control!.stalls).toEqual([{ objectId: 'out', signal: 'admit', sinceMs: 1000 }]);
    expect(state(r, 'st', 'blocked')).toBe(59_000);
    // On (the initial value), the same line runs freely.
    const open = line({
      program: program([['OPEN', 'output', true]]),
      sensors: [],
      actuators: [{ id: 'a1', objectId: 'out', signal: 'admit', variable: 'OPEN' }],
    });
    expect(runFactory(open).produced).toBe(6);
  });

  it('reads the occupied, ready, blocked, full and failed sensors at each scan', () => {
    const doc = newFactory('Sensors');
    doc.objects = [
      {
        id: 'in',
        name: 'In',
        kind: 'source',
        interval: c(1000),
        mix: [{ productId: 'part', weight: 1 }],
        limit: 3,
      },
      { id: 'buf', name: 'Buffer', kind: 'buffer', capacity: 2 },
      {
        id: 'st',
        name: 'Station',
        kind: 'station',
        processTime: c(10_000),
        failures: { uptime: c(5000), repair: c(2000) },
      },
      { id: 'out', name: 'Out', kind: 'drain' },
    ];
    doc.links = [
      { id: 'l1', from: 'in', to: 'buf' },
      { id: 'l2', from: 'buf', to: 'st' },
      { id: 'l3', from: 'st', to: 'out' },
    ];
    const names = ['OCC', 'RDY', 'BLK', 'FULL', 'FAIL'];
    doc.control = {
      program: program(names.map((n) => [n, 'input'] as [string, 'input'])),
      sensors: [
        { id: 's1', objectId: 'buf', signal: 'occupied', variable: 'OCC' },
        { id: 's2', objectId: 'buf', signal: 'ready', variable: 'RDY' },
        { id: 's3', objectId: 'buf', signal: 'blocked', variable: 'BLK' },
        { id: 's4', objectId: 'buf', signal: 'full', variable: 'FULL' },
        { id: 's5', objectId: 'st', signal: 'failed', variable: 'FAIL' },
      ],
      actuators: [],
    };
    doc.run = { durationMs: 20_000, seed: 1 };
    const r = runFactory(doc, { record: true });
    const at = (k: number, t: number) => {
      let v = 0;
      const s = r.timeline!.signals;
      for (let i = 0; i < s.length; i += 4)
        if (s[i + 1] === 0 && s[i + 2] === k && s[i]! <= t) v = s[i + 3]!;
      return v;
    };
    // Parts at 0, 1, 2 s: the first goes on to the station, the next two wait in the buffer.
    expect([0, 1, 2, 3].map((k) => at(k, 500))).toEqual([0, 0, 0, 0]);
    expect([0, 1, 2, 3].map((k) => at(k, 2500))).toEqual([1, 1, 1, 1]);
    // The station fails after 5 s of processing and is repaired 2 s later.
    expect([4900, 5000, 6900, 7000].map((t) => at(4, t))).toEqual([0, 1, 1, 0]);
  });
});
