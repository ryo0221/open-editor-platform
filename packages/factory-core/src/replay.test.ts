import { describe, expect, it } from 'vitest';
import {
  f170SmallLine,
  f175PlcLineBug,
  FactoryReplay,
  type FactoryTimeline,
  factoryStates,
  newFactory,
  runFactory,
  type FactoryDocument,
  type FactoryPlacement,
} from './index';

const c = (sec: number) => ({ type: 'const' as const, value: sec * 1000 });
const at = (doc: FactoryDocument) =>
  new Map<string, FactoryPlacement>(
    doc.objects.map((o, i) => [o.id, o.at ?? { x: i * 4000, y: 0 }]),
  );
const replay = (doc: FactoryDocument) => {
  const r = runFactory(doc, { record: true });
  return { r, replay: new FactoryReplay(doc, r.timeline!, at(doc), r.endMs) };
};

// TS-2661: FT4b replay of a recorded run.
describe('FT4b replay (TS-2661)', () => {
  it('shows each object in a state its places are in, and parts where they are', () => {
    const doc = f170SmallLine();
    const { r, replay: rp } = replay(doc);
    const conveyor = doc.objects.findIndex((o) => o.kind === 'conveyor');
    const drains = new Set(doc.objects.flatMap((o, i) => (o.kind === 'drain' ? [i] : [])));
    for (const t of [0, 1234, r.endMs / 3, r.endMs / 2 + 17, r.endMs]) {
      const f = rp.at(t);
      expect(f.states).toHaveLength(doc.objects.length);
      f.states.forEach((s, i) => {
        // The state shown is one a place of the object is in at t.
        const rows = r.timeline!.states[i]!;
        const covering: number[] = [];
        for (let k = 0; k < rows.length; k += 4)
          if (rows[k]! <= t && (t < rows[k + 1]! || (t === r.endMs && rows[k + 1] === t)))
            covering.push(rows[k + 2]!);
        expect(covering).toContain(s);
      });
      expect(f.parts.every((p) => !drains.has(p.object))).toBe(true);
      expect(new Set(f.parts.map((p) => p.part)).size).toBe(f.parts.length);
      // On the accumulating conveyor: in [0, 1], at least a part length apart, oldest ahead.
      const on = f.parts.filter((p) => p.object === conveyor).map((p) => p.along!);
      on.sort((a, b) => b - a);
      const o = doc.objects[conveyor]!;
      if (o.kind !== 'conveyor') throw new Error('conveyor');
      on.forEach((a, k) => {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        if (k) expect(on[k - 1]! - a).toBeGreaterThanOrEqual(o.partLengthMm / o.lengthMm - 1e-9);
      });
    }
    // Somewhere in the run the machining shows working, and the line holds parts.
    const machining = doc.objects.findIndex((o) => o.id === 'machining');
    const mid = rp.at(r.endMs / 2);
    expect(factoryStates[mid.states[machining]!]).toBeDefined();
    expect(mid.parts.length).toBeGreaterThan(0);
  });

  it('drives a vehicle along its segment and parks it at the segment end', () => {
    const doc = newFactory('agv');
    doc.paths = {
      nodes: [
        { id: 'p-a', x: 0, y: 0 },
        { id: 'p-b', x: 20_000, y: 0 },
      ],
      segments: [{ id: 's', from: 'p-a', to: 'p-b', twoWay: true }],
    };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 5000,
        unloadMs: 5000,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(60),
        mix: [{ productId: 'part', weight: 1 }],
        pathNodeId: 'p-a',
      },
      { id: 'b', name: 'b', kind: 'station', processTime: c(10), pathNodeId: 'p-b' },
      { id: 'out', name: 'out', kind: 'drain' },
    ];
    doc.links = [
      { id: 'l1', from: 'in', to: 'b', transport: { fleetId: 'agv' } },
      { id: 'l2', from: 'b', to: 'out' },
    ];
    doc.run = { durationMs: 600_000, seed: 1 };
    const { r, replay: rp } = replay(doc);
    // The first part is made at 0 and loaded at once: the vehicle holds it while loading.
    expect(rp.at(0).vehicles).toEqual([
      expect.objectContaining({ x: 0, y: 0, driving: false, loaded: true }),
    ]);
    const d = r.timeline!.drives;
    const loaded = [];
    for (let k = 0; k < d.length; k += 7) if (d[k + 6]! >= 0) loaded.push(d.slice(k, k + 7));
    const [start, end] = loaded[0]!;
    const half = rp.at((start! + end!) / 2).vehicles[0]!;
    expect(half).toMatchObject({ driving: true, loaded: true, y: 0 });
    expect(half.x).toBeCloseTo(10_000, -1);
    expect(half.heading).toBeCloseTo(0);
    expect(rp.at(end! + 1).vehicles[0]).toMatchObject({ x: 20_000, driving: false });
    // The part on the vehicle is drawn on it only, not also at the source it left.
    const carried = loaded[0]![6]!;
    expect(rp.at((start! + end!) / 2).parts.map((p) => p.part)).not.toContain(carried);
    // Unloading (5 s after the drive) it still holds the part: not back at the source.
    const unloading = rp.at(end! + 2000);
    expect(unloading.vehicles[0]).toMatchObject({ driving: false, loaded: true });
    expect(unloading.parts.map((p) => p.part)).not.toContain(carried);
    // Once unloaded the part is at the station and the vehicle empty.
    const after = rp.at(end! + 5001);
    expect(after.vehicles[0]!.loaded).toBe(false);
    expect(after.parts.find((p) => p.part === carried)?.object).toBe(1);
  });

  it('stands the parts on a belt whose motor the PLC turned off', () => {
    // F175: the ladder bug drops the conveyor's run output at 130 s and never sets it again.
    const doc = f175PlcLineBug();
    const { r, replay: rp } = replay(doc);
    const belt = doc.objects.findIndex((o) => o.kind === 'conveyor');
    expect(r.timeline!.belts.slice(0, 3)).toEqual([130_000, belt, 1]);
    const on = (t: number) => rp.at(t).parts.filter((p) => p.object === belt);
    // A part that entered after the stop stays where it entered.
    expect(on(150_000)).toEqual(on(180_000));
    expect(on(180_000).map((p) => p.along)).toEqual([1, 0]);
  });

  it('keeps a hold the run ends in, and the failure of a place over a held one', () => {
    // Load 5 s, drive 20 s, unload 5 s: the 28 s run ends while unloading.
    const doc = newFactory('unfinished');
    doc.paths = {
      nodes: [
        { id: 'p-a', x: 0, y: 0 },
        { id: 'p-b', x: 20_000, y: 0 },
      ],
      segments: [{ id: 's', from: 'p-a', to: 'p-b', twoWay: true }],
    };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 5000,
        unloadMs: 5000,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(60),
        mix: [{ productId: 'part', weight: 1 }],
        pathNodeId: 'p-a',
      },
      { id: 'out', name: 'out', kind: 'drain', pathNodeId: 'p-b' },
    ];
    doc.links = [{ id: 'l1', from: 'in', to: 'out', transport: { fleetId: 'agv' } }];
    doc.run = { durationMs: 28_000, seed: 1 };
    const { replay: rp } = replay(doc);
    const end = rp.at(27_000);
    expect(end.vehicles[0]).toMatchObject({ x: 20_000, driving: false, loaded: true });
    expect(end.parts.find((p) => p.object === 0)).toBeUndefined();

    // A two-place station: one place failed, the other held (a PLC release off).
    const st = newFactory('places');
    st.objects = [{ id: 'p', name: 'p', kind: 'parallel', places: 2, processTime: c(1) } as never];
    const timeline = {
      states: [
        [
          0,
          10_000,
          factoryStates.indexOf('failed'),
          0,
          0,
          10_000,
          factoryStates.indexOf('held'),
          1,
        ],
      ],
      moves: [],
      walks: [],
      drives: [],
      loads: [],
      belts: [],
      signals: [],
      truncated: false,
    } as unknown as FactoryTimeline;
    const frame = new FactoryReplay(st, timeline, at(st), 10_000).at(5000);
    expect(factoryStates[frame.states[0]!]).toBe('failed');
  });

  it('closes an accumulating queue at its pickup when the delivery is past the run', () => {
    // 10 m belt at 1 m/s, parts every 0.5 s; the AGV drives 20 s each way: its second pickup is
    // at 52 s and that part reaches the drain after the 60 s run.
    const doc = newFactory('open pickup');
    doc.paths = {
      nodes: [
        { id: 'p-a', x: 0, y: 0 },
        { id: 'p-b', x: 20_000, y: 0 },
      ],
      segments: [{ id: 's', from: 'p-a', to: 'p-b', twoWay: true }],
    };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 1000,
        unloadMs: 1000,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: { type: 'const', value: 500 },
        mix: [{ productId: 'part', weight: 1 }],
      },
      {
        id: 'belt',
        name: 'belt',
        kind: 'conveyor',
        lengthMm: 10_000,
        speedMmS: 1000,
        partLengthMm: 500,
        accumulating: true,
        pathNodeId: 'p-a',
      },
      { id: 'out', name: 'out', kind: 'drain', pathNodeId: 'p-b' },
    ];
    doc.links = [
      { id: 'l1', from: 'in', to: 'belt' },
      { id: 'l2', from: 'belt', to: 'out', transport: { fleetId: 'agv' } },
    ];
    doc.run = { durationMs: 60_000, seed: 1 };
    const { replay: rp } = replay(doc);
    // Between frames 1 ms apart no part on the belt moves more than the belt does (1 mm).
    for (let t = 40_000; t < 60_000; t += 250) {
      const a = new Map(
        rp
          .at(t - 1)
          .parts.filter((p) => p.object === 1)
          .map((p) => [p.part, p.along!]),
      );
      for (const p of rp.at(t).parts)
        if (p.object === 1 && a.has(p.part))
          expect(Math.abs(p.along! - a.get(p.part)!)).toBeLessThanOrEqual(0.0002);
    }
  });

  it('keeps a part on its vehicle at the last instant of a run that ends before the delivery', () => {
    // Loading 5 s, driving 20 s, unloading 5 s; the 28 s run ends while the part is on board.
    const doc = newFactory('loaded at the end');
    doc.paths = {
      nodes: [
        { id: 'p-a', x: 0, y: 0 },
        { id: 'p-b', x: 20_000, y: 0 },
      ],
      segments: [{ id: 's', from: 'p-a', to: 'p-b', twoWay: true }],
    };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 5000,
        unloadMs: 5000,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: { type: 'const', value: 100_000 },
        mix: [{ productId: 'part', weight: 1 }],
        pathNodeId: 'p-a',
      },
      { id: 'out', name: 'out', kind: 'drain', pathNodeId: 'p-b' },
    ];
    doc.links = [{ id: 'l', from: 'in', to: 'out', transport: { fleetId: 'agv' } }];
    doc.run = { durationMs: 28_000, seed: 1 };
    const { replay: rp, r } = replay(doc);
    expect(r.produced).toBe(0);
    for (const t of [27_999, 28_000]) {
      const f = rp.at(t);
      expect(f.vehicles[0]!.loaded).toBe(true);
      expect(f.parts.filter((p) => p.object === 0)).toEqual([]);
    }
  });

  it('empties a vehicle after a trip of no time at all', () => {
    // Source and drain at one node, no loading or unloading: picked up and delivered at 0.
    const doc = newFactory('instant');
    doc.paths = { nodes: [{ id: 'p-a', x: 0, y: 0 }], segments: [] };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 0,
        unloadMs: 0,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(60),
        mix: [{ productId: 'part', weight: 1 }],
        pathNodeId: 'p-a',
      },
      { id: 'out', name: 'out', kind: 'drain', pathNodeId: 'p-a' },
    ];
    doc.links = [{ id: 'l1', from: 'in', to: 'out', transport: { fleetId: 'agv' } }];
    doc.run = { durationMs: 10_000, seed: 1 };
    const { r, replay: rp } = replay(doc);
    expect(r.timeline!.loads.slice(0, 1)).toEqual([0]);
    expect(rp.at(5000).vehicles[0]!.loaded).toBe(false);
    // Delivered at once to a station (10 s): the part works there, the vehicle is empty.
    const st = structuredClone(doc);
    st.objects.splice(1, 0, {
      id: 'b',
      name: 'b',
      kind: 'station',
      processTime: c(10),
      pathNodeId: 'p-a',
    });
    st.links = [
      { id: 'l1', from: 'in', to: 'b', transport: { fleetId: 'agv' } },
      { id: 'l2', from: 'b', to: 'out' },
    ];
    const s5 = replay(st).replay.at(5000);
    expect(s5.vehicles[0]!.loaded).toBe(false);
    expect(s5.parts.map((p) => p.object)).toEqual([1]);
  });

  it('holds a part on a trip whose ends share a path node (no drive)', () => {
    // Source and drain at the one node: the AGV loads (1 s) and unloads (10 s) without driving.
    const doc = newFactory('same node');
    doc.paths = { nodes: [{ id: 'p-a', x: 0, y: 0 }], segments: [] };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 1000,
        unloadMs: 10_000,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(60),
        mix: [{ productId: 'part', weight: 1 }],
        pathNodeId: 'p-a',
      },
      { id: 'out', name: 'out', kind: 'drain', pathNodeId: 'p-a' },
    ];
    doc.links = [{ id: 'l1', from: 'in', to: 'out', transport: { fleetId: 'agv' } }];
    doc.run = { durationMs: 120_000, seed: 1 };
    const { r, replay: rp } = replay(doc);
    expect(r.timeline!.drives).toEqual([]);
    const mid = rp.at(5000);
    expect(mid.vehicles[0]).toMatchObject({ driving: false, loaded: true });
    // The part is on the vehicle, not still at the source.
    expect(mid.parts.find((p) => p.object === 0)).toBeUndefined();
    // Unloaded at 11 s: the vehicle is empty again.
    expect(rp.at(11_500).vehicles[0]!.loaded).toBe(false);
  });

  it('carries a part again on its next vehicle-backed link', () => {
    // source → station → drain, both links by the one AGV on a 10 m segment.
    const doc = newFactory('legs');
    doc.paths = {
      nodes: [
        { id: 'p-a', x: 0, y: 0 },
        { id: 'p-b', x: 10_000, y: 0 },
        { id: 'p-c', x: 20_000, y: 0 },
      ],
      segments: [
        { id: 's1', from: 'p-a', to: 'p-b', twoWay: true },
        { id: 's2', from: 'p-b', to: 'p-c', twoWay: true },
      ],
    };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 1000,
        unloadMs: 1000,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(600),
        mix: [{ productId: 'part', weight: 1 }],
        pathNodeId: 'p-a',
      },
      { id: 'b', name: 'b', kind: 'station', processTime: c(2), pathNodeId: 'p-b' },
      { id: 'out', name: 'out', kind: 'drain', pathNodeId: 'p-c' },
    ];
    doc.links = [
      { id: 'l1', from: 'in', to: 'b', transport: { fleetId: 'agv' } },
      { id: 'l2', from: 'b', to: 'out', transport: { fleetId: 'agv' } },
    ];
    doc.run = { durationMs: 120_000, seed: 1 };
    const { r, replay: rp } = replay(doc);
    const d = r.timeline!.drives;
    const loaded: number[][] = [];
    for (let k = 0; k < d.length; k += 7) if (d[k + 6]! >= 0) loaded.push(d.slice(k, k + 7));
    const part = loaded[0]![6]!;
    const second = loaded.find((x) => x[0]! > loaded[0]![1]! + 1000 && x[6] === part)!;
    expect(second).toBeDefined();
    // Midway through the second leg the part rides on the vehicle, not at the station.
    const mid = rp.at((second[0]! + second[1]!) / 2);
    expect(mid.vehicles[0]).toMatchObject({ driving: true, loaded: true });
    expect(mid.parts.map((p) => p.part)).not.toContain(part);
    // Between the legs it is at the station and the vehicle carries nothing.
    const between = rp.at((loaded[0]![1]! + 1000 + second[0]!) / 2);
    expect(between.parts.find((p) => p.part === part)?.object).toBe(1);
  });

  it('closes a belt queue up when a vehicle takes its head, not when it delivers', () => {
    // A 10 m accumulating belt fed every second, emptied by one AGV on a 10 m segment.
    const doc = newFactory('belt-agv');
    doc.paths = {
      nodes: [
        { id: 'p-a', x: 0, y: 0 },
        { id: 'p-b', x: 10_000, y: 0 },
      ],
      segments: [{ id: 's', from: 'p-a', to: 'p-b', twoWay: true }],
    };
    doc.fleets = [
      {
        id: 'agv',
        name: 'AGVs',
        count: 1,
        speedMmS: 1000,
        loadMs: 1000,
        unloadMs: 1000,
        homeNodeId: 'p-a',
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(1),
        mix: [{ productId: 'part', weight: 1 }],
      },
      {
        id: 'belt',
        name: 'belt',
        kind: 'conveyor',
        lengthMm: 10_000,
        speedMmS: 1000,
        partLengthMm: 500,
        accumulating: true,
        pathNodeId: 'p-a',
      },
      { id: 'out', name: 'out', kind: 'drain', pathNodeId: 'p-b' },
    ];
    doc.links = [
      { id: 'l1', from: 'in', to: 'belt' },
      { id: 'l2', from: 'belt', to: 'out', transport: { fleetId: 'agv' } },
    ];
    doc.run = { durationMs: 90_000, seed: 1 };
    const { replay: rp } = replay(doc);
    // No part on the belt ever moves back.
    const last = new Map<number, number>();
    let checked = 0;
    for (let t = 0; t <= 90_000; t += 100) {
      for (const p of rp.at(t).parts) {
        if (p.object !== 1) continue;
        const before = last.get(p.part);
        if (before !== undefined) {
          expect(p.along!).toBeGreaterThanOrEqual(before - 1e-9);
          checked++;
        }
        last.set(p.part, p.along!);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('walks a worker between the objects it serves', () => {
    const doc = newFactory('crew');
    const st = (id: string, x: number) => ({
      id,
      name: id,
      kind: 'station' as const,
      processTime: c(10),
      at: { x, y: 0 },
      workers: { count: 1 },
    });
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(1),
        mix: [{ productId: 'part', weight: 1 }],
        at: { x: -4000, y: 0 },
      },
      st('a', 0),
      st('b', 10_000),
      { id: 'out', name: 'out', kind: 'drain', at: { x: 14_000, y: 0 } },
    ];
    doc.links = [
      { id: 'l0', from: 'in', to: 'a' },
      { id: 'l1', from: 'a', to: 'b' },
      { id: 'l2', from: 'b', to: 'out' },
    ];
    doc.workerPools = [{ id: 'crew', name: 'Crew', count: 1, skills: [], walkSpeedMmS: 1000 }];
    doc.run = { durationMs: 300_000, seed: 3 };
    const { r, replay: rp } = replay(doc);
    const w = r.timeline!.walks;
    // The first walk that goes somewhere: from a to b, 10 s.
    let k = 0;
    while (k < w.length && w[k + 1] === w[k]) k += 5;
    const [start, arrive] = [w[k]!, w[k + 1]!];
    const mid = rp.at((start + arrive) / 2).workers[0]!;
    expect(mid.walking).toBe(true);
    expect(Math.abs(mid.x - 5000)).toBeLessThan(200);
    expect(rp.at(arrive).workers[0]).toMatchObject({ walking: false });
  });

  it('stops a non-accumulating belt while its head is blocked', () => {
    const doc = newFactory('belt');
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(3),
        mix: [{ productId: 'part', weight: 1 }],
      },
      {
        id: 'belt',
        name: 'belt',
        kind: 'conveyor',
        lengthMm: 10_000,
        speedMmS: 1000,
        partLengthMm: 500,
        accumulating: false,
      },
      { id: 'st', name: 'st', kind: 'station', processTime: c(100) },
      { id: 'out', name: 'out', kind: 'drain' },
    ];
    doc.links = doc.objects
      .slice(1)
      .map((o, i) => ({ id: `l${i}`, from: doc.objects[i]!.id, to: o.id }));
    doc.run = { durationMs: 60_000, seed: 1 };
    const { replay: rp } = replay(doc);
    const on = (t: number) =>
      rp
        .at(t)
        .parts.filter((p) => p.object === 1)
        .map((p) => Number(p.along!.toFixed(3)));
    // From 13 s the head waits at the end for the busy station: the belt stands still.
    // (A part may still come on at the start where there is room; those on it do not move.)
    expect(on(16_000).slice(0, 4)).toEqual(on(13_500));
    expect(on(13_500)[0]).toBe(1);
    // Before then the belt ran: the trailing part moved.
    expect(on(11_000)).not.toEqual(on(12_500));
  });

  it('closes an accumulating queue up at the belt speed when its head leaves', () => {
    const doc = newFactory('queue');
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(1),
        mix: [{ productId: 'part', weight: 1 }],
      },
      {
        id: 'belt',
        name: 'belt',
        kind: 'conveyor',
        lengthMm: 10_000,
        speedMmS: 1000,
        partLengthMm: 500,
        accumulating: true,
      },
      { id: 'st', name: 'st', kind: 'station', processTime: c(5) },
      { id: 'out', name: 'out', kind: 'drain' },
    ];
    doc.links = doc.objects
      .slice(1)
      .map((o, i) => ({ id: `l${i}`, from: doc.objects[i]!.id, to: o.id }));
    doc.run = { durationMs: 120_000, seed: 1 };
    const { replay: rp } = replay(doc);
    // Every 100 ms a part on the belt moves at most 100 mm (0.01 of it): no jumps to the end.
    let was = new Map<number, number>();
    let queued = 0;
    for (let t = 30_000; t <= 90_000; t += 100) {
      const now = new Map(
        rp
          .at(t)
          .parts.filter((p) => p.object === 1)
          .map((p) => [p.part, p.along!] as const),
      );
      queued = Math.max(queued, now.size);
      for (const [part, a] of now)
        if (was.has(part)) expect(a - was.get(part)!).toBeLessThanOrEqual(0.01 + 1e-9);
      was = now;
    }
    expect(queued).toBeGreaterThan(3);
  });

  it('replays a truncated recording only as far as it is complete', () => {
    const doc = f170SmallLine();
    const r = runFactory(doc, { record: true, maxRecords: 500 });
    const t = r.timeline!;
    expect(t.truncated).toBe(true);
    const rp = new FactoryReplay(doc, t, at(doc), r.endMs);
    expect(rp.endMs).toBe(t.recordedUntilMs);
    expect(rp.endMs).toBeLessThan(r.endMs);
    expect(rp.at(r.endMs).timeMs).toBe(rp.endMs);
  });

  it('keeps what began by the cut, so a truncated replay matches the whole one', () => {
    // A blocked belt: its stopped interval (from 13 s) is recorded only when it ends.
    const doc = newFactory('belt');
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(3),
        mix: [{ productId: 'part', weight: 1 }],
      },
      {
        id: 'belt',
        name: 'belt',
        kind: 'conveyor',
        lengthMm: 10_000,
        speedMmS: 1000,
        partLengthMm: 500,
        accumulating: false,
      },
      { id: 'st', name: 'st', kind: 'station', processTime: c(100) },
      { id: 'out', name: 'out', kind: 'drain' },
    ];
    doc.links = doc.objects
      .slice(1)
      .map((o, i) => ({ id: `l${i}`, from: doc.objects[i]!.id, to: o.id }));
    doc.run = { durationMs: 60_000, seed: 1 };
    const { r: whole, replay: full } = replay(doc);
    const t0 = whole.timeline!;
    const all = t0.moves.length / 5 + t0.states.reduce((n, s) => n + s.length / 4, 0);
    for (const maxRecords of [4, 8, 16, Math.floor(all / 2), all - 2]) {
      const r = runFactory(doc, { record: true, maxRecords });
      const cut = new FactoryReplay(doc, r.timeline!, at(doc), r.endMs);
      expect(r.timeline!.truncated).toBe(true);
      // Up to the cut, the truncated replay shows what the whole one shows.
      for (let t = 0; t <= cut.endMs; t += 500) expect(cut.at(t)).toEqual(full.at(t));
      expect(cut.at(cut.endMs)).toEqual(full.at(cut.endMs));
    }
  });

  it('indexes long stays without copying them across the run', () => {
    const doc = newFactory('year');
    const year = 365 * 24 * 3_600_000;
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(1),
        mix: [{ productId: 'part', weight: 1 }],
        limit: 1001,
      },
      { id: 'buf', name: 'buf', kind: 'buffer', capacity: 1000 },
      { id: 'st', name: 'st', kind: 'station', processTime: { type: 'const', value: year } },
      { id: 'out', name: 'out', kind: 'drain' },
    ];
    doc.links = doc.objects
      .slice(1)
      .map((o, i) => ({ id: `l${i}`, from: doc.objects[i]!.id, to: o.id }));
    doc.run = { durationMs: year, seed: 1 };
    const { replay: rp } = replay(doc);
    const kept = (rp as unknown as { checkpoints: unknown[][] }).checkpoints.reduce(
      (n, c) => n + c.length,
      0,
    );
    expect(kept).toBeLessThan(10_000);
    expect(rp.at(year / 2).parts.length).toBe(1001);
  });
  it('finds each pickup without rescanning a recirculating part', () => {
    // One part carried back and forth 60,000 times: each pickup is found among its own stays.
    const doc = newFactory('loop');
    doc.objects = [
      { id: 'a', name: 'a', kind: 'station', processTime: c(1) },
      { id: 'b', name: 'b', kind: 'station', processTime: c(1) },
    ];
    doc.fleets = [
      { id: 'agv', name: 'AGVs', count: 1, speedMmS: 1000, loadMs: 0, unloadMs: 0 } as never,
    ];
    const n = 60_000;
    const moves: number[] = [];
    const loads: number[] = [];
    for (let i = 0; i < n; i++) {
      moves.push(2 * i, 0, 0, i ? (i - 1) % 2 : -1, i % 2);
      loads.push(2 * i + 1, 0, 0, 0, i % 2);
    }
    const timeline = {
      states: [[], []],
      moves,
      walks: [],
      drives: [],
      loads,
      belts: [],
      signals: [],
      truncated: false,
    } as unknown as FactoryTimeline;
    const t0 = performance.now();
    const rp = new FactoryReplay(doc, timeline, at(doc), 2 * n);
    expect(performance.now() - t0).toBeLessThan(2000);
    // Held from its pickup until it arrives at the other station; the last one, never delivered, open.
    const holds = (rp as unknown as { holds: number[][][][] }).holds[0]![0]!;
    expect(holds).toHaveLength(n);
    expect(holds[0]).toEqual([1, 2, 0]);
    expect(holds[n - 1]).toEqual([2 * n - 1, Infinity, 0]);
  });
});
