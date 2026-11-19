import { describe, expect, it } from 'vitest';
import {
  factoryWarnings,
  newFactory,
  runFactory,
  validateFactory,
  type FactoryDocument,
  type FactoryFleet,
  type FactoryRunResult,
} from './index';

const H = 3_600_000;
const c = (sec: number) => ({ type: 'const' as const, value: sec * 1000 });
const share = (r: FactoryRunResult, id: string, s: string) => {
  const o = r.objects.find((x) => x.id === id)!;
  return o.states[s as keyof typeof o.states] / (r.endMs - r.startMs);
};
const fleet = (extra: Partial<FactoryFleet> = {}): FactoryFleet => ({
  id: 'agv',
  name: 'AGVs',
  count: 1,
  speedMmS: 1000,
  loadMs: 5000,
  unloadMs: 5000,
  homeNodeId: 'p-a',
  ...extra,
});
/**
 * Source → station a → buffer (at p-a) → AGV → station b (at p-b, 20 m away) → drain. The
 * vehicles drive a one-way ring p-a → p-b → p-c → p-a of 20 + 20 + 28.3 m.
 */
function agvLine(fleets: FactoryFleet[], aSec = 10, hours = 1): FactoryDocument {
  const doc = newFactory('agv');
  doc.paths = {
    nodes: [
      { id: 'p-a', x: 0, y: 0 },
      { id: 'p-b', x: 20_000, y: 0 },
      { id: 'p-c', x: 20_000, y: 20_000 },
    ],
    segments: [
      { id: 's-ab', from: 'p-a', to: 'p-b' },
      { id: 's-bc', from: 'p-b', to: 'p-c' },
      { id: 's-ca', from: 'p-c', to: 'p-a' },
    ],
  };
  doc.fleets = fleets;
  doc.objects = [
    {
      id: 'in',
      name: 'in',
      kind: 'source',
      interval: c(1),
      mix: [{ productId: 'part', weight: 1 }],
    },
    { id: 'a', name: 'a', kind: 'station', processTime: c(aSec), pathNodeId: 'p-a' },
    { id: 'buf', name: 'buf', kind: 'buffer', capacity: 20, pathNodeId: 'p-a' },
    { id: 'b', name: 'b', kind: 'station', processTime: c(10), pathNodeId: 'p-b' },
    { id: 'out', name: 'out', kind: 'drain' },
  ];
  doc.links = [
    { id: 'l1', from: 'in', to: 'a' },
    { id: 'l1b', from: 'a', to: 'buf' },
    { id: 'l2', from: 'buf', to: 'b', transport: { fleetId: 'agv' } },
    { id: 'l3', from: 'b', to: 'out' },
  ];
  doc.run = { durationMs: hours * H, seed: 2 };
  return doc;
}

// TS-2658: FT3c vehicles on a path network.
describe('FT3c vehicles (TS-2658)', () => {
  it('one vehicle carries every part round the ring', () => {
    // Per trip: load 5 s, 20 s to b, unload 5 s, 48.3 s back = 78.3 s.
    const r = runFactory(agvLine([fleet()]), { record: true });
    expect(r.produced).toBeGreaterThanOrEqual(44);
    expect(r.produced).toBeLessThanOrEqual(46);
    expect(r.flows.l2).toBe(r.fleets[0]!.trips);
    expect(r.fleets[0]!.shares.loaded).toBeCloseTo((r.fleets[0]!.trips * 20) / 3600, 1);
    // The buffer waits for vehicles (transport, not blocked); a is blocked by the full buffer.
    expect(share(r, 'buf', 'transport')).toBeGreaterThan(0.9);
    expect(share(r, 'buf', 'blocked')).toBe(0);
    // Parts move buf → b in the timeline; loaded vehicles drive only p-a → p-b.
    const moves = r.timeline!.moves;
    for (let i = 0; i < moves.length; i += 5) if (moves[i + 3] === 2) expect(moves[i + 4]).toBe(3);
    const drives = r.timeline!.drives;
    for (let i = 0; i < drives.length; i += 7)
      if (drives[i + 6]! >= 0) expect(drives[i + 4]).toBe(0);
    const shares = Object.values(r.fleets[0]!.shares).reduce((a, b) => a + b, 0);
    expect(shares).toBeCloseTo(1, 6);
  });

  it('more vehicles carry more, until they queue on the ring', () => {
    const runs = [1, 2, 3, 6].map((n) => runFactory(agvLine([fleet({ count: n })])));
    const produced = runs.map((r) => r.produced);
    expect(produced[1]!).toBeGreaterThan(produced[0]! * 1.8);
    expect(produced[2]!).toBeGreaterThan(produced[1]! * 1.3);
    // Six vehicles hardly add any: they spend half their time waiting for segments.
    expect(produced[3]!).toBeLessThan(produced[2]! * 1.1);
    expect(runs[3]!.fleets[0]!.shares.traffic).toBeGreaterThan(0.4);
    expect(runs[0]!.fleets[0]!.shares.traffic).toBe(0);
  });

  it('a vehicle charges when its battery runs low', () => {
    const battery = {
      capacityMs: 600_000,
      chargeMs: 300_000,
      chargerNodeId: 'p-c',
      rechargeBelow: 0.2,
    };
    const r = runFactory(agvLine([fleet({ battery })]));
    const s = r.fleets[0]!.shares;
    expect(s.charging).toBeGreaterThan(0.1);
    expect(r.produced).toBeLessThan(runFactory(agvLine([fleet()])).produced);
  });

  it('stops and reports a deadlock on a two-way segment', () => {
    // Two vehicles meet head-on on a single two-way lane between two loops.
    const doc = agvLine([fleet({ count: 2 })]);
    doc.paths = {
      nodes: [
        { id: 'p-a', x: 0, y: 0 },
        { id: 'p-b', x: 20_000, y: 0 },
        { id: 'p-m', x: 10_000, y: 0 },
      ],
      segments: [
        { id: 's-am', from: 'p-a', to: 'p-m', twoWay: true },
        { id: 's-mb', from: 'p-m', to: 'p-b', twoWay: true },
      ],
    };
    doc.fleets = [
      fleet({ id: 'agv', count: 1 }),
      fleet({ id: 'agv2', count: 1, homeNodeId: 'p-b' }),
    ];
    doc.objects.push({
      id: 'c',
      name: 'c',
      kind: 'station',
      processTime: c(10),
      pathNodeId: 'p-a',
    });
    doc.objects.splice(3, 0, {
      id: 'in2',
      name: 'in2',
      kind: 'source',
      interval: c(1),
      mix: [{ productId: 'part', weight: 1 }],
    });
    doc.objects.push({
      id: 'b2',
      name: 'b2',
      kind: 'station',
      processTime: c(10),
      pathNodeId: 'p-b',
    });
    doc.links.push(
      { id: 'l4', from: 'in2', to: 'b2' },
      { id: 'l5', from: 'b2', to: 'c', transport: { fleetId: 'agv2' } },
      { id: 'l6', from: 'c', to: 'out' },
    );
    expect(validateFactory(doc)).toEqual([]);
    const r = runFactory(doc);
    expect(r.deadlock).toBeDefined();
    expect(r.deadlock!.vehicles.sort()).toEqual(['agv#1', 'agv2#1']);
    expect(r.deadlock!.segments.sort()).toEqual(['s-am', 's-mb']);
    expect(r.endMs).toBe(r.deadlock!.atMs);
    // A deadlock inside the warm-up gives an empty measured period at the deadlock.
    const early = runFactory(doc, { warmupMs: 10 * H });
    expect(early.deadlock!.atMs).toBe(r.deadlock!.atMs);
    expect(early.startMs).toBe(early.endMs);
    expect(early.produced).toBe(0);
    for (const o of early.objects) expect(Object.values(o.states).every((v) => v === 0)).toBe(true);
  });

  it('takes a job only with the charge to drive it', () => {
    // At 0.25 m/s, 80 s to b on a 60 s battery: never delivered.
    const battery = (capacityMs: number) => ({
      capacityMs,
      chargeMs: 60_000,
      chargerNodeId: 'p-a',
      rechargeBelow: 0.2,
    });
    const r = runFactory(agvLine([fleet({ speedMmS: 250, battery: battery(60_000) })]));
    expect(r.produced).toBe(0);
    expect(r.fleets[0]!.trips).toBe(0);
    // On a 120 s battery each trip needs a charge first: some parts, and much charging.
    const ok = runFactory(agvLine([fleet({ speedMmS: 250, battery: battery(120_000) })]));
    expect(ok.produced).toBeGreaterThan(0);
    expect(ok.fleets[0]!.shares.charging).toBeGreaterThan(0.2);
  });

  it('routes least-busy past carried links by the parts at their destination', () => {
    // The queues stand at the pickup, so the vehicles never leave it: a part every 200 s finds
    // both links open.
    const doc = agvLine([fleet({ count: 2 })], 200);
    doc.objects.push(
      { id: 'q1', name: 'q1', kind: 'buffer', capacity: 10, pathNodeId: 'p-a' },
      { id: 'q2', name: 'q2', kind: 'buffer', capacity: 10, pathNodeId: 'p-a' },
    );
    doc.objects = doc.objects.map((o) => (o.id === 'buf' ? { ...o, exit: 'least-busy' } : o));
    // b is replaced by two queues with no exit: each part goes to the shorter one.
    doc.links = doc.links
      .filter((l) => l.id !== 'l2' && l.id !== 'l3')
      .concat(
        { id: 'l2', from: 'buf', to: 'q1', transport: { fleetId: 'agv' } },
        { id: 'l2b', from: 'buf', to: 'q2', transport: { fleetId: 'agv' } },
      );
    doc.objects = doc.objects.filter((o) => o.id !== 'b' && o.id !== 'out');
    // q1 also fills from a source of its own, so the parts should go to q2.
    doc.objects.push({
      id: 'in2',
      name: 'in2',
      kind: 'source',
      interval: c(1),
      mix: [{ productId: 'part', weight: 1 }],
    });
    doc.objects = doc.objects.map((o) => (o.id === 'q1' ? { ...o, capacity: 10_000 } : o));
    doc.links.push({ id: 'l7', from: 'in2', to: 'q1' });
    const r = runFactory(doc);
    // q2 takes most; q1 only when q2's vehicle is still busy (first-free among open links).
    expect(r.flows.l2b!).toBeGreaterThan(10);
    expect(r.flows.l2b!).toBeGreaterThan(r.flows.l2!);
  });

  it('calls vehicles only for the parts a link may carry', () => {
    // At 0 s the buffer holds one part for l2 and then two others for l2x. Only one of the
    // three l2 vehicles (parked at p-b) should drive round to the pickup.
    const doc = agvLine([fleet({ count: 3, homeNodeId: 'p-b' }), fleet({ id: 'agv2' })]);
    doc.products.push({ id: 'other', name: 'Other' });
    const src = (id: string, productId: string, limit: number, startMs: number) => ({
      id,
      name: id,
      kind: 'source' as const,
      interval: c(1000),
      mix: [{ productId, weight: 1 }],
      limit,
      startMs,
    });
    doc.objects = [
      src('in', 'part', 1, 0),
      src('in2', 'other', 2, 1),
      ...doc.objects.filter((o) => o.id !== 'in' && o.id !== 'a'),
      { id: 'b2', name: 'b2', kind: 'station', processTime: c(10), pathNodeId: 'p-b' },
    ];
    doc.links = [
      { id: 'l1', from: 'in', to: 'buf' },
      { id: 'l1x', from: 'in2', to: 'buf' },
      { id: 'l2', from: 'buf', to: 'b', transport: { fleetId: 'agv' }, productIds: ['part'] },
      { id: 'l2x', from: 'buf', to: 'b2', transport: { fleetId: 'agv2' }, productIds: ['other'] },
      { id: 'l3', from: 'b', to: 'out' },
      { id: 'l3x', from: 'b2', to: 'out' },
    ];
    doc.run = { durationMs: 300_000, seed: 1 };
    expect(validateFactory(doc)).toEqual([]);
    const r = runFactory(doc);
    // One vehicle drives 48.3 s round to the pickup and 20 s back to b with the part.
    const f = r.fleets[0]!;
    expect(f.trips).toBe(1);
    expect(f.shares.empty * 3 * 300_000).toBeCloseTo(48_284, -2);
  });

  it('never delivers to a drop that no path reaches', () => {
    const doc = agvLine([fleet()]);
    doc.paths!.nodes.push({ id: 'p-x', x: 0, y: 50_000 });
    doc.objects = doc.objects.map((o) => (o.id === 'b' ? { ...o, pathNodeId: 'p-x' } : o));
    expect(validateFactory(doc)).toEqual([]);
    expect(factoryWarnings(doc).map((w) => w.code)).toEqual(['path-unreachable']);
    const r = runFactory(doc);
    expect(r.produced).toBe(0);
    expect(r.fleets[0]!.trips).toBe(0);
  });

  it('refuses transport without fleets or path nodes', () => {
    const doc = agvLine([fleet()]);
    const codes = (d: unknown) => validateFactory(d).map((x) => `${x.code}@${x.path}`);
    const noFleet = structuredClone(doc);
    noFleet.links[2]!.transport = { fleetId: 'x' };
    expect(codes(noFleet)).toEqual(['fleet-missing@$.links.2.transport.fleetId']);
    const noNode = structuredClone(doc);
    delete noNode.objects[3]!.pathNodeId;
    expect(codes(noNode)).toEqual(['no-path-node@$.links.2.to']);
    expect(codes({ ...doc, fleets: [fleet({ homeNodeId: 'nowhere' })] })).toEqual([
      'path-node-missing@$.fleets.0.homeNodeId',
    ]);
    const segs = doc.paths!.segments;
    const twice = { ...doc.paths!, segments: [...segs, { id: 's-x', from: 'p-a', to: 'p-b' }] };
    expect(codes({ ...doc, paths: twice })).toEqual(['duplicate-segment@$.paths.segments.3']);
    // Without the way back the vehicle cannot return: a warning, not an error.
    const oneWay = { ...doc, paths: { ...doc.paths!, segments: [segs[0]!] } };
    expect(codes(oneWay)).toEqual([]);
    expect(factoryWarnings(oneWay).map((w) => w.code)).toEqual(['path-unreachable']);
    expect(factoryWarnings(doc)).toEqual([]);
  });
});
